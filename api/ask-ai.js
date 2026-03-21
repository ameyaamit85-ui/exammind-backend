const { evaluate } = require('mathjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

function extractCleanJSON(rawText) {
    let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (e) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            try { return JSON.parse(cleaned.substring(start, end + 1)); } catch (inner) {}
        }
        throw new Error("No valid JSON found.");
    }
}

async function computeNumericAnswer(formula, userQuery, groqApiKey) {
    if (!formula || !userQuery) return null;
    const extractorPrompt = `Formula: "${formula}"\nUser: "${userQuery}"\nIf applicable, output {"applicable":true,"vars":{...}} else {"applicable":false}. JSON only.`;
    try {
        const extractRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${groqApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "system", content: extractorPrompt }],
                temperature: 0
            })
        });
        const extractData = await extractRes.json();
        if (extractData.error) throw new Error(extractData.error.message);
        const extractJSON = extractCleanJSON(extractData.choices[0].message.content);
        if (extractJSON.applicable && extractJSON.vars) {
            const result = evaluate(formula, extractJSON.vars);
            return Math.round(result * 10000) / 10000;
        }
        return null;
    } catch (err) { return null; }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).json({ error: true, details: 'Only POST allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is missing.");

        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATION_API_KEY;

        if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing.");
        if (modelChoice === 'flash-lite' && !GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing.");

        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) {}
        }

        let computedAnswer = null;
        if (retrievedCard && retrievedCard.formula_used && !isFollowUp) {
            computedAnswer = await computeNumericAnswer(retrievedCard.formula_used, promptText, GROQ_API_KEY);
        }

        let promptForAI = "";
        if (isFollowUp) {
            promptForAI = `You are an elite engineering tutor. User: "${promptText}". Context: ${contextData || "None"}. Answer in plain text.`;
        } else {
            let computedText = computedAnswer !== null ? `\nExact computed answer: ${computedAnswer}. Use this in "final_answer".` : "";
            promptForAI = `You are ExamMind AI. Output ONLY JSON with fields: name, desc, formula_used, solution_steps (array), final_answer, trap (start with 🚨). 
Query: "${promptText}"
Context: ${contextData || "None"}${computedText}`;
        }

        let finalResponseText = "";
        let engineUsed = "";

        if (modelChoice === 'flash-lite') {
            engineUsed = "Gemini 3.1 Flash Lite";
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
            const result = await model.generateContent(promptForAI);
            finalResponseText = result.response.text();
        } else {
            engineUsed = "Llama 3.3 70B (Groq)";
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "system", content: promptForAI }],
                    temperature: 0.1
                })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            finalResponseText = data.choices[0].message.content;
        }

        if (!isFollowUp) {
            try {
                const jsonObj = extractCleanJSON(finalResponseText);
                finalResponseText = JSON.stringify(jsonObj);
            } catch (err) {
                finalResponseText = JSON.stringify({
                    name: "Error",
                    desc: "Failed to parse AI response. Please try again.",
                    formula_used: "",
                    solution_steps: ["Refresh and retry"],
                    final_answer: "",
                    trap: "🚨 AI output formatting issue."
                });
            }
        }

        res.status(200).json({ content: finalResponseText, routedTo: engineUsed });
    } catch (error) {
        console.error("ExamMind API Error:", error.message);
        res.status(200).json({ error: true, details: error.message });
    }
};
