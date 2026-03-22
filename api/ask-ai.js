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

// Helper to convert base64 image data for Gemini Vision
function fileToGenerativePart(base64Data) {
    const parts = base64Data.split(';');
    const mimeType = parts[0].split(':')[1];
    const data = parts[1].split(',')[1];
    return {
        inlineData: {
            data: data,
            mimeType: mimeType
        },
    };
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).json({ error: true, details: 'Only POST allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp, isImage, imageData } = req.body || {};
        if (!promptText && !isImage) throw new Error("Prompt text or Image is missing.");

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
        // 📸 PHASE 0: IMAGE VISION PROCESSING
        // ==========================================
        if (isImage && imageData) {
            console.log("📸 Vision Engine Triggered!");
            engineUsed = "Gemini 1.5 Vision";
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            
            // 🔥 FIX: Added '-latest' to fix the 404 API Not Found Error
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

            const imagePart = fileToGenerativePart(imageData);
            
            const visionPrompt = `You are an elite Engineering Copilot. 
            I have provided an image of an engineering question or concept.
            
            Your Task:
            1. Carefully read and extract the question from the image.
            2. Solve it step-by-step.
            3. OUTPUT STRICTLY IN THIS JSON FORMAT (NO MARKDOWN, NO CONVERSATION):
            {
                "name": "Short Topic Name (e.g. Heat Transfer Calc)",
                "desc": "Explanation of the theory behind this problem.",
                "formula_used": "Plain text formula used to solve it",
                "solution_steps": ["Step 1...", "Step 2..."],
                "final_answer": "Final numeric answer with units",
                "trap": "🚨 Mention a common mistake students make solving this"
            }`;

            const result = await model.generateContent([visionPrompt, imagePart]);
            finalResponseText = result.response.text();
        } 
        
        // ==========================================
        // 🔍 PHASE 1: SEMANTIC VECTOR RETRIEVAL
        // ==========================================
        else if (!isFollowUp) {
            try {
                const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
                const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
                const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

                const embedResult = await embedModel.embedContent(promptText);
                let queryEmbedding = embedResult.embedding.values;

                if (queryEmbedding.length > 768) {
                    queryEmbedding = queryEmbedding.slice(0, 768);
                    const mag = Math.sqrt(queryEmbedding.reduce((sum, val) => sum + val * val, 0));
                    queryEmbedding = queryEmbedding.map(v => v / mag);
                }

                const { data: matchedConcepts, error: rpcError } = await supabase.rpc('match_concepts', {
                    query_embedding: queryEmbedding,
                    match_threshold: 0.3,
                    match_count: 2
                });

                if (!rpcError && matchedConcepts && matchedConcepts.length > 0) {
                    dynamicContext = matchedConcepts.map(c => `Concept: ${c.name}. Formula: ${c.formula_used}. Description: ${c.desc_text}`).join(" | ");
                    matchedFormula = matchedConcepts[0].formula_used;
                } else {
                    dynamicContext = contextData || "None";
                }
            } catch (vecErr) {
                dynamicContext = contextData || "None";
            }
        } else {
            dynamicContext = contextData || "None";
        }

        // ==========================================
        // 🧠 PHASE 2: TEXT GENERATION
        // ==========================================
        if (!isImage) { 
            const masterJSONPrompt = `You are an elite Engineering Copilot. 
User Query: "${promptText}"
Verified Knowledge Context: ${dynamicContext}

CRITICAL RULES FOR OUTPUT:
1. If theory: Put explanation in "desc", leave "final_answer" empty.
2. If numerical: Put calculated result in "final_answer".
3. DO NOT hallucinate formulas. Use provided context if available.
${computedAnswer !== null ? `4. CRITICAL: The exact math answer is **${computedAnswer}**. USE THIS NUMERIC VALUE.` : ''}

OUTPUT STRICTLY IN THIS JSON FORMAT (NO MARKDOWN, DO NOT WRAP IN BACKTICKS):
{
    "name": "Short Concept Title",
    "desc": "Detailed text explanation goes here.",
    "formula_used": "Plain text formula (or empty)",
    "solution_steps": ["Step 1...", "Step 2..."],
    "final_answer": "Short numeric answer with units ONLY",
    "trap": "🚨 Mention a common mistake (or empty)"
}`;

            if (modelChoice === 'flash-lite') {
                engineUsed = "Gemini 1.5 Flash";
                const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
                // 🔥 FIX: Using robust latest string
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

                const geminiPrompt = isFollowUp ? `You are a tutor. Query: "${promptText}". Context: ${dynamicContext}. Output plain text only. No JSON.` : masterJSONPrompt;
                const result = await model.generateContent(geminiPrompt);
                finalResponseText = result.response.text();

            } else {
                engineUsed = "Llama 3.3 70B (Groq)";
                const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
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
                    } catch (err) {}
                }

                const llamaPrompt = isFollowUp ? `You are a tutor. Query: "${promptText}". Context: ${dynamicContext}. Output plain text. NO JSON.` : masterJSONPrompt;
                const finalRes = await fetch(GROQ_URL, {
                    method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: llamaPrompt }, { role: "user", content: promptText }], temperature: 0.1 })
                });

                const finalData = await finalRes.json();
                if (finalData.error) throw new Error(finalData.error.message);
                finalResponseText = finalData.choices[0].message.content;
            }
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
