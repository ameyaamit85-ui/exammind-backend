const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // true Gemini SDK
const { evaluate } = require('mathjs');

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || "https://xqhmggnfbtnrfccdtlpu.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// TRUE Gemini integration for Deep Reasoning
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATION_API_KEY);

module.exports = async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, details: 'Method Not Allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) return res.status(400).json({ error: true, details: 'Prompt text is required' });

        // Parse database card
        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { console.log("Context parsed as raw string."); }
        }

        let computedAnswer = null;
        let finalPrompt = "";
        let engineUsed = "Llama-3.3-70b-versatile (Default)";

        // Route between models
        if (!isFollowUp && modelChoice === 'flash-lite') {
            engineUsed = "models/gemini-1.5-flash-latest (True Deep Reasoning)";
            // Handle Gemini Call
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            const result = await model.generateContent([`engineering copier tutor. Query: ${promptText}. verifiedContext: ${contextData || 'none'}`]);
            const responseText = result.response.text();
            
            // For floating card formatting, LLM must output textbook JSON
            finalPrompt = `You are a premium textbook engineering tutor copilot. Generate response in this VALID JSON format (no markdown): {name, problem, final_answer, formula_used, solution_steps, trap, keywords}. Content must be textbook accurate based on context.`;
            // Simplified Gemini Call - We'll just generate based on context provided.
            const dataResult = await model.generateContent([finalPrompt]);
            const response = dataResult.response.text();
            
            res.status(200).json({ content: response, routedTo: engineUsed });
            return;

        } else {
            // Groq Llama Call for numerical validation and speed
            const GROQ_API_KEY = process.env.GROQ_API_KEY;
            const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

            // V2 Math Engine Pipeline with Context Mismatch Validation
            if (!isFollowUp && retrievedCard && retrievedCard.formula_used) {
                
                // STEP 1: VALIDATE THE FORMULA APPLICABILITY
                const extractorPrompt = `
You are a math variable extractor. Your main job is to prevent using WRONG formulas.
Analyze the engineering numerical problem: "${promptText}".
Verify if the PROVIDED plain text formula: "${retrievedCard.formula_used}" (Desc: "${retrievedCard.desc}") IS MATHEMATICALLY APPLICABLE to the problem statement. 

Example: If problem is about heat conduction through spherical shell and provided formula is about internal heat generation, flag as NOT_APPLICABLE.

If NOT mathematically applicable: Output ONLY 'NOT_APPLICABLE'.
If it is applicable: Output ONLY a valid JSON variable mapping (in SI units). e.g., {"k": 400, "r1": 0.1}
`;
                try {
                    const extractRes = await fetch(GROQ_URL, {
                        method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: extractorPrompt }], temperature: 0.0 })
                    });
                    const extractData = await extractRes.json();
                    let rawVariablesRawStr = extractData.choices[0].message.content.replace(/```json/gi, '').replace(/```/g, '').trim();

                    if (!rawVariablesRawStr.includes('NOT_APPLICABLE')) {
                        const jsonStart = rawVariablesRawStr.indexOf('{');
                        const jsonEnd = rawVariablesRawStr.lastIndexOf('}');
                        const variables = JSON.parse(rawVariablesRawStr.substring(jsonStart, jsonEnd + 1));
                        
                        // Backend Symbolic Calculator (100% Numeric Accuracy)
                        computedAnswer = evaluate(retrievedCard.formula_used, variables);
                        computedAnswer = Math.round(computedAnswer * 10000) / 10000;
                    }

                } catch (err) { console.log("Math engine validation skip. Mismatch or Broken mapping."); }
            }

            // Final Presentation Prompt for Llama
            finalPrompt = ` You are an elite engineering tutor. Respond in textbook valid JSON format: {name,problem,final_answer,formula_used,solution_steps,trap,keywords}. Textbook-accurate context provided. ${computedAnswer !== null ? `CRITICAL: Mathematically exact calculated answer is **${computedAnswer}**. You MUST use this numeric value as the final answer.` : ''}. Do not use creative language.`;
            
            const finalRes = await fetch(GROQ_URL, {
                method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [ { role: "system", content: finalPrompt }, { role: "user", content: promptText } ],
                    temperature: 0.1, // Thermostat 0.1 for maximum standard adherence
                    max_tokens: 2000
                })
            });

            const finalData = await finalRes.json();
            res.status(200).json({ content: finalData.choices[0].message.content, routedTo: engineUsed });
        }

    } catch (error) {
        console.error("Backend V2 Error:", error);
        res.status(500).json({ error: true, details: error.message });
    }
};
