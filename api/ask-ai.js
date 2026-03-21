const { evaluate } = require('mathjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    // 🛡️ Always return 200 OK with JSON to prevent Chrome Ext "Token A" HTML crashes
    if (req.method !== 'POST') return res.status(200).json({ error: true, details: 'Only POST allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is missing.");

        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATION_API_KEY;

        if (!GROQ_API_KEY) throw new Error("CRITICAL: GROQ_API_KEY missing in Vercel.");

        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { /* Ignore bad context */ }
        }

        let computedAnswer = null;
        let finalResponseText = "";
        let engineUsed = "";

        const masterJSONPrompt = `You are an elite Engineering Copilot. 
User Query: "${promptText}"
Database Context: ${contextData || "None"}

CRITICAL RULES FOR OUTPUT:
1. If the query asks for THEORY/EXPLANATION: Put the full explanation in the "desc" field. Leave "final_answer" as an empty string "".
2. If the query is a NUMERICAL PROBLEM: Put the calculated result in "final_answer" (e.g. "150.5 W"). Put theory/steps in "desc" and "solution_steps".
3. DO NOT hallucinate formulas. If you don't know it natively or via context, leave "formula_used" empty.
${computedAnswer !== null ? `4. CRITICAL: The exact calculated math answer is **${computedAnswer}**. USE THIS NUMERIC VALUE.` : ''}

OUTPUT STRICTLY IN THIS JSON FORMAT (NO MARKDOWN):
{
    "name": "Short Concept Title",
    "desc": "Detailed text explanation goes here. Never put long paragraphs in final_answer.",
    "formula_used": "Plain text formula (or empty)",
    "solution_steps": ["Step 1...", "Step 2..."],
    "final_answer": "Short numeric answer with units ONLY. Empty if theory.",
    "trap": "🚨 Mention a common mistake (or empty)"
}`;

        if (modelChoice === 'flash-lite') {
            if (!GEMINI_API_KEY) throw new Error("CRITICAL: GEMINI_API_KEY missing in Vercel Env Variables.");
            engineUsed = "Gemini 3.1 Flash Lite";
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            // 🔥 STRICTLY USING EXACT MODEL STRING
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

            const geminiPrompt = isFollowUp 
                ? `You are an elite tutor. Query: "${promptText}". Context: ${contextData}. Output plain text only. No JSON.`
                : masterJSONPrompt;

            const result = await model.generateContent(geminiPrompt);
            finalResponseText = result.response.text();

        } else {
            engineUsed = "Llama 3.3 70B (Groq)";
            const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

            if (!isFollowUp && retrievedCard && retrievedCard.formula_used) {
                const extractorPrompt = `Check if this formula: "${retrievedCard.formula_used}" applies to: "${promptText}". 
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

            const llamaPrompt = isFollowUp
                ? `You are an elite tutor. Query: "${promptText}". Context: ${contextData}. Output plain text. NO JSON.`
                : masterJSONPrompt;

            const finalRes = await fetch(GROQ_URL, {
                method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: llamaPrompt }, { role: "user", content: promptText }], temperature: 0.1 })
            });

            const finalData = await finalRes.json();
            if (finalData.error) throw new Error(finalData.error.message);
            finalResponseText = finalData.choices[0].message.content;
        }

        if (!isFollowUp) {
            const validJSON = extractCleanJSON(finalResponseText);
            finalResponseText = JSON.stringify(validJSON); 
        }

        res.status(200).json({ content: finalResponseText, routedTo: engineUsed });

    } catch (error) {
        console.error("ExamMind API Error:", error.message);
        res.status(200).json({ error: true, details: error.message });
    }
};
