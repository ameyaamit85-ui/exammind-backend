const { evaluate } = require('mathjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

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
    if (req.method !== 'POST') return res.status(200).json({ error: true, details: 'Only POST allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is missing.");

        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATION_API_KEY;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

        if (!GROQ_API_KEY || !GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
            throw new Error("CRITICAL: API Keys or Supabase credentials missing in Vercel Env Variables.");
        }

        let computedAnswer = null;
        let finalResponseText = "";
        let engineUsed = "";
        let dynamicContext = "";
        let matchedFormula = null;

        // ==========================================
        // 🔍 PHASE 1: SEMANTIC VECTOR RETRIEVAL (TRUE RAG)
        // ==========================================
        if (!isFollowUp) {
            try {
                const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
                const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
                const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

                // 1. Embed user query
                const embedResult = await embedModel.embedContent(promptText);
                let queryEmbedding = embedResult.embedding.values;

                // 2. Compress vector to 768 dimensions (Matryoshka) to match Supabase
                if (queryEmbedding.length > 768) {
                    queryEmbedding = queryEmbedding.slice(0, 768);
                    const mag = Math.sqrt(queryEmbedding.reduce((sum, val) => sum + val * val, 0));
                    queryEmbedding = queryEmbedding.map(v => v / mag);
                }

                // 3. Search Supabase for the closest mathematical concepts
                const { data: matchedConcepts, error: rpcError } = await supabase.rpc('match_concepts', {
                    query_embedding: queryEmbedding,
                    match_threshold: 0.3, // Match threshold
                    match_count: 2       // Get top 2 closest concepts
                });

                if (!rpcError && matchedConcepts && matchedConcepts.length > 0) {
                    // Create context string from retrieved vectors
                    dynamicContext = matchedConcepts.map(c => `Concept: ${c.name}. Formula: ${c.formula_used}. Description: ${c.desc_text}`).join(" | ");
                    matchedFormula = matchedConcepts[0].formula_used;
                    console.log("Vector RAG Success: Found matches in Supabase!");
                } else {
                    dynamicContext = contextData || "None";
                }
            } catch (vecErr) {
                console.log("Vector Search Bypassed/Failed:", vecErr.message);
                dynamicContext = contextData || "None";
            }
        } else {
            dynamicContext = contextData || "None";
        }

        // ==========================================
        // 🧠 PHASE 2: MASTER PROMPT & GENERATION
        // ==========================================
        const masterJSONPrompt = `You are an elite Engineering Copilot. 
User Query: "${promptText}"
Verified Knowledge Database Context: ${dynamicContext}

CRITICAL RULES FOR OUTPUT:
1. If the query asks for THEORY: Put the explanation in the "desc" field. Leave "final_answer" as an empty string "".
2. If the query is NUMERICAL: Put the calculated result in "final_answer" (e.g. "150.5 W"). Put steps in "solution_steps".
3. DO NOT hallucinate formulas. If the provided Knowledge Database Context has a formula, use it. If not, rely on your deep engineering knowledge.
${computedAnswer !== null ? `4. CRITICAL: The exact calculated math answer is **${computedAnswer}**. USE THIS NUMERIC VALUE.` : ''}

OUTPUT STRICTLY IN THIS JSON FORMAT (NO MARKDOWN, DO NOT WRAP IN BACKTICKS):
{
    "name": "Short Concept Title",
    "desc": "Detailed text explanation goes here.",
    "formula_used": "Plain text formula (or empty)",
    "solution_steps": ["Step 1...", "Step 2..."],
    "final_answer": "Short numeric answer with units ONLY. Empty if theory.",
    "trap": "🚨 Mention a common mistake (or empty)"
}`;

        // ==========================================
        // ⚡ PHASE 3: ROUTING & MATH SANDBOX
        // ==========================================
        if (modelChoice === 'flash-lite') {
            engineUsed = "Gemini 3.1 Flash Lite";
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

            const geminiPrompt = isFollowUp 
                ? `You are an elite tutor. Query: "${promptText}". Context: ${dynamicContext}. Output plain text only. No JSON.`
                : masterJSONPrompt;

            const result = await model.generateContent(geminiPrompt);
            finalResponseText = result.response.text();

        } else {
            engineUsed = "Llama 3.3 70B (Groq)";
            const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

            // 🧮 Safe Math Extraction using the Best Formula from Vector Search
            let formulaToUse = matchedFormula || (contextData ? JSON.parse(contextData).formula_used : null);

            if (!isFollowUp && formulaToUse && formulaToUse.length > 2) {
                const extractorPrompt = `Check if this formula: "${formulaToUse}" applies to the numerical problem: "${promptText}". 
                If NOT applicable, output: {"applicable": false}. 
                If YES, extract variables safely to SI units and output: {"applicable": true, "vars": {"k": 400, "r": 0.1}}. NO EXTRA TEXT.`;
                
                try {
                    const extractRes = await fetch(GROQ_URL, {
                        method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: extractorPrompt }], temperature: 0 })
                    });
                    const extractData = await extractRes.json();
                    const extractJSON = extractCleanJSON(extractData.choices[0].message.content);

                    if (extractJSON.applicable && extractJSON.vars) {
                        computedAnswer = evaluate(formulaToUse, extractJSON.vars);
                        computedAnswer = Math.round(computedAnswer * 10000) / 10000;
                    }
                } catch (err) { console.log("Math engine bypassed safely."); }
            }

            const llamaPrompt = isFollowUp
                ? `You are an elite tutor. Query: "${promptText}". Context: ${dynamicContext}. Output plain text. NO JSON.`
                : masterJSONPrompt;

            const finalRes = await fetch(GROQ_URL, {
                method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: llamaPrompt }, { role: "user", content: promptText }], temperature: 0.1 })
            });

            const finalData = await finalRes.json();
            if (finalData.error) throw new Error(finalData.error.message);
            finalResponseText = finalData.choices[0].message.content;
        }

        // ==========================================
        // 🛡️ PHASE 4: STRICT JSON FORMATTING
        // ==========================================
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
