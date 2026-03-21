const { evaluate } = require('mathjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Utility function to extract pure JSON from hallucinated LLM text
function extractCleanJSON(rawText) {
    try {
        const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const startIdx = cleaned.indexOf('{');
        const endIdx = cleaned.lastIndexOf('}');
        if (startIdx === -1 || endIdx === -1) throw new Error("No JSON structure found.");
        return JSON.parse(cleaned.substring(startIdx, endIdx + 1));
    } catch (e) {
        throw new Error("AI failed to output valid JSON structure.");
    }
}

module.exports = async function handler(req, res) {
    // 🛡️ LAYER 1: BULLETPROOF CORS & HEADERS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).json({ error: true, details: 'Only POST allowed' }); // Returning 200 with error JSON to prevent Chrome Ext crash

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is completely missing.");

        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GOOGLE_GENERATION_API_KEY;

        if (!GROQ_API_KEY) throw new Error("CRITICAL: GROQ_API_KEY missing in Vercel.");

        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { /* Ignore bad context */ }
        }

        let computedAnswer = null;
        let finalResponseText = "";
        let engineUsed = "";

        // 🛡️ LAYER 2: THE ROUTER & MATH SANDBOX
        if (modelChoice === 'flash-lite') {
            // 🧠 ENGINE A: TRUE GEMINI API (For Deep Reasoning)
            if (!GEMINI_API_KEY) throw new Error("CRITICAL: GOOGLE_GENERATION_API_KEY missing for Gemini.");
            engineUsed = "Gemini 3.1 Flash Lite";
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Using 1.5 flash as the standard API endpoint for flash-lite tier

            const geminiPrompt = isFollowUp 
                ? `You are an elite engineering tutor. Answer the query: "${promptText}". Context: ${contextData}. Output plain text only.`
                : `You are an elite engineering tutor. Query: "${promptText}". Context: ${contextData || "None"}. 
                   CRITICAL: Output STRICTLY as a JSON object: {"name":"Title","formula_used":"formula or empty","solution_steps":["step1"],"final_answer":"answer","trap":"🚨 trap or empty"}. No markdown.`;

            const result = await model.generateContent(geminiPrompt);
            finalResponseText = result.response.text();

        } else {
            // ⚡ ENGINE B: GROQ LLAMA 3.3 70B (Fast Engine with MathJS)
            engineUsed = "Llama 3.3 70B (Groq)";
            const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

            // If it's a main question and we have a formula, try to calculate safely
            if (!isFollowUp && retrievedCard && retrievedCard.formula_used) {
                const extractorPrompt = `Check if this formula: "${retrievedCard.formula_used}" is completely applicable to this question: "${promptText}". 
                If NOT applicable, output: {"applicable": false}. 
                If YES, extract variables to SI units and output: {"applicable": true, "vars": {"k": 400, "r": 0.1}}. NO EXTRA TEXT.`;
                
                try {
                    const extractRes = await fetch(GROQ_URL, {
                        method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: extractorPrompt }], temperature: 0 })
                    });
                    const extractData = await extractRes.json();
                    const extractJSON = extractCleanJSON(extractData.choices[0].message.content);

                    if (extractJSON.applicable && extractJSON.vars) {
                        computedAnswer = evaluate(retrievedCard.formula_used, extractJSON.vars);
                        computedAnswer = Math.round(computedAnswer * 10000) / 10000;
                    }
                } catch (err) { console.log("Math engine bypassed safely."); }
            }

            // Final Prompt for Llama
            const llamaPrompt = isFollowUp
                ? `You are an elite tutor. Query: "${promptText}". Context: ${contextData}. Output plain text. NO JSON.`
                : `You are an elite Engineering Copilot. 
                   User Query: "${promptText}"
                   Database Context: ${contextData || "None"}
                   ${computedAnswer !== null ? `CRITICAL INSTRUCTION: The exact calculated answer is **${computedAnswer}**. USE THIS NUMERIC VALUE.` : 'If the context does not match the query, ignore the context and solve from your own knowledge.'}
                   
                   OUTPUT STRICTLY IN THIS JSON FORMAT (NO MARKDOWN, NO TEXT OUTSIDE):
                   {
                     "name": "Short Title",
                     "formula_used": "Plain text formula",
                     "solution_steps": ["Step 1", "Step 2"],
                     "final_answer": "Final answer with units",
                     "trap": "🚨 Mention a common mistake"
                   }`;

            const finalRes = await fetch(GROQ_URL, {
                method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: llamaPrompt }, { role: "user", content: promptText }], temperature: 0.1 })
            });

            const finalData = await finalRes.json();
            if (finalData.error) throw new Error(finalData.error.message);
            finalResponseText = finalData.choices[0].message.content;
        }

        // 🛡️ LAYER 3: FORMAT VALIDATION BEFORE SENDING TO EXTENSION
        if (!isFollowUp) {
            // Force clean JSON before sending back. If it fails, the catch block handles it safely.
            const validJSON = extractCleanJSON(finalResponseText);
            // We stringify it back so the extension receives consistent data
            finalResponseText = JSON.stringify(validJSON); 
        }

        res.status(200).json({ content: finalResponseText, routedTo: engineUsed });

    } catch (error) {
        console.error("ExamMind Core API Error:", error.message);
        // 🛡️ THE BULLETPROOF FIX: We ALWAYS return 200 status with JSON. Never HTML. Never 500.
        res.status(200).json({ error: true, details: error.message });
    }
};
