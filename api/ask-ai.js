const { createClient } = require('@supabase/supabase-js');
const { evaluate } = require('mathjs'); // 🔥 Apna naya Math Engine

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || "https://xqhmggnfbtnrfccdtlpu.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') return res.status(405).json({ error: true, details: 'Method Not Allowed' });

    try {
        const { promptText, contextData, modelChoice, isFollowUp } = req.body;
        if (!promptText) return res.status(400).json({ error: true, details: 'Prompt text is required' });

        // Groq API URL & Key
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
        
        // Model selection
        let selectedModel = "llama-3.3-70b-versatile"; 
        if (modelChoice === 'flash-lite') {
            selectedModel = "llama-3.1-8b-instant"; // Using Llama 8b as fallback if Groq doesn't support flash-lite directly
        }

        // Parse Context Data (Database json card)
        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { console.log("No valid context"); }
        }

        let computedAnswer = null;
        let finalPrompt = "";

        // ==========================================
        // ⚙️ THE MATH ENGINE PIPELINE
        // ==========================================
        if (!isFollowUp && retrievedCard && retrievedCard.formula_used && retrievedCard.solution_steps) {
            
            // STEP 1: AI se sirf variables nikalwao (No Calculation)
            const extractorPrompt = `
            You are an expert at extracting numbers. DO NOT SOLVE.
            Question: "${promptText}"
            Formula to use: "${retrievedCard.formula_used}"
            
            Extract the numerical values from the question that match the variables in the formula. Convert to standard SI units if obvious.
            Output ONLY a raw JSON object with variable names as keys and numbers as values. Example: {"k": 400, "r1": 0.1}
            `;

            try {
                const extractRes = await fetch(GROQ_URL, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: selectedModel,
                        messages: [{ role: "system", content: extractorPrompt }],
                        temperature: 0.1
                    })
                });
                
                const extractData = await extractRes.json();
                let rawJsonStr = extractData.choices[0].message.content;
                
                // Clean JSON
                rawJsonStr = rawJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
                const jsonStart = rawJsonStr.indexOf('{');
                const jsonEnd = rawJsonStr.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    const variables = JSON.parse(rawJsonStr.substring(jsonStart, jsonEnd + 1));
                    
                    // STEP 2: math.js se 100% correct calculation karo
                    computedAnswer = evaluate(retrievedCard.formula_used, variables);
                    // Answer round off to 4 decimal places
                    computedAnswer = Math.round(computedAnswer * 10000) / 10000; 
                }
            } catch (err) {
                console.log("Math Engine Extraction Failed, falling back to pure LLM", err.message);
            }

            // Prepare Final Prompt for LLM to just format the answer beautifully
            finalPrompt = `
            You are an elite Engineering Copilot.
            
            Context from Verified Database:
            - Concept: ${retrievedCard.name || retrievedCard.problem}
            - Formula: ${retrievedCard.formula_used}
            - Standard Steps: ${JSON.stringify(retrievedCard.solution_steps)}
            - Common Trap: ${retrievedCard.trap}
            
            ${computedAnswer !== null ? `CRITICAL INSTRUCTION: The mathematically exact answer is **${computedAnswer}**. You MUST use this final answer. Do not recalculate.` : ''}
            
            Generate the final response STRICTLY as a JSON object with these keys:
            {
              "name": "Concept Name",
              "formula_used": "Plain text formula",
              "solution_steps": ["Step 1...", "Step 2..."],
              "final_answer": "Final numeric answer with units",
              "trap": "Trap warning starting with 🚨"
            }
            Do not include markdown blocks like \`\`\`json.
            `;

        } else {
            // Normal Theory / ELI5 / FollowUp Routing
            finalPrompt = `You are ExamMind AI, an elite engineering copilot. Answer the user's query clearly and concisely. If it's a follow-up, respond in plain text formatting (no JSON). Context: ${contextData}`;
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
        res.status(500).json({ error: true, details: error.message });
    }
};
