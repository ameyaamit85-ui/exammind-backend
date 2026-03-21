const { evaluate } = require('mathjs');

module.exports = async function handler(req, res) {
    // 🛡️ 1. Set CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, details: 'Only POST requests allowed.' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is missing.");

        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing in Vercel Environment Variables!");

        const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
        let selectedModel = modelChoice === 'flash-lite' ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile"; 

        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { /* Ignore */ }
        }

        let computedAnswer = null;
        let finalPrompt = "";

        // ==========================================
        // ⚙️ MAIN PIPELINE
        // ==========================================
        if (!isFollowUp) {
            // It's a Main Search (Needs strict JSON response for the floating card)

            // Step 1: If it's a numerical with a formula, extract & calculate!
            if (retrievedCard && retrievedCard.formula_used) {
                const extractorPrompt = `
                Extract numerical values from this question: "${promptText}" 
                for this formula: "${retrievedCard.formula_used}".
                Output ONLY a valid JSON object. Example: {"k": 400, "r1": 0.1}. No text.
                `;
                try {
                    const extractRes = await fetch(GROQ_URL, {
                        method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: selectedModel, messages: [{ role: "system", content: extractorPrompt }], temperature: 0.1 })
                    });
                    const extractData = await extractRes.json();
                    if (extractData.choices && extractData.choices[0]) {
                        let rawJsonMatch = extractData.choices[0].message.content.match(/\{[\s\S]*\}/);
                        if (rawJsonMatch) {
                            const variables = JSON.parse(rawJsonMatch[0]);
                            computedAnswer = evaluate(retrievedCard.formula_used, variables);
                            computedAnswer = Math.round(computedAnswer * 10000) / 10000;
                        }
                    }
                } catch (err) { console.log("Math engine skip"); }
            }

            // Step 2: The Final JSON Prompt (Works for both Theory and Numericals)
            finalPrompt = `
            You are an elite Engineering Copilot.
            User Query: "${promptText}"
            Context from Verified Database: ${contextData || "None."}
            
            ${computedAnswer !== null ? `CRITICAL: The exact mathematically calculated answer is **${computedAnswer}**. You MUST use this as the final numeric answer.` : ''}
            
            YOU MUST RESPOND STRICTLY IN THIS JSON FORMAT. DO NOT OUTPUT ANY CONVERSATIONAL TEXT.
            {
              "name": "Short, Punchy Title (Max 5 words)",
              "formula": "Any relevant formula in plain text (or leave empty)",
              "steps": ["Step 1 explanation", "Step 2 explanation"],
              "answer": "Detailed explanation OR the final numeric answer with units",
              "trap": "🚨 Mention a common student mistake or leave empty"
            }
            `;

        } else {
            // It's a Follow Up (ELI5, Ask AI) - Needs plain text
            finalPrompt = `You are ExamMind AI, an elite engineering tutor. Answer the query clearly and concisely. Context: ${contextData}. Output plain formatted text, NO JSON.`;
        }

        // ==========================================
        // 🚀 FINAL LLM CALL
        // ==========================================
        const finalRes = await fetch(GROQ_URL, {
            method: "POST",
            headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: selectedModel,
                messages: [
                    { role: "system", content: finalPrompt },
                    { role: "user", content: promptText }
                ],
                temperature: 0.2
            })
        });

        const finalData = await finalRes.json();
        if (finalData.error) throw new Error(finalData.error.message);

        res.status(200).json({
            content: finalData.choices[0].message.content,
            routedTo: selectedModel
        });

    } catch (error) {
        console.error("Backend Error:", error);
        // We MUST return a 200 with an error object so the extension doesn't crash on HTML
        res.status(200).json({ error: true, details: error.message });
    }
};
