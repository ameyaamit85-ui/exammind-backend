const { evaluate } = require('mathjs');

module.exports = async function handler(req, res) {
    // 🛡️ 1. Set CORS Headers (Crucial for Chrome Extensions)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: true, details: 'Only POST requests allowed.' });
    }

    try {
        // 🛡️ 2. Safe parsing of Request Body
        const { promptText, contextData, modelChoice, isFollowUp } = req.body || {};
        if (!promptText) throw new Error("Prompt text is completely missing from the request.");

        // 🛡️ 3. API Key Check
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        if (!GROQ_API_KEY) throw new Error("CRITICAL: GROQ_API_KEY is missing in Vercel Environment Variables!");

        const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
        let selectedModel = modelChoice === 'flash-lite' ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile"; 

        // 🛡️ 4. Safe parsing of Context Data (JSON from Extension)
        let retrievedCard = null;
        if (contextData) {
            try { retrievedCard = JSON.parse(contextData); } catch (e) { console.log("Context is not JSON. Using as raw string."); }
        }

        let computedAnswer = null;
        let finalPrompt = "";

        // ==========================================
        // ⚙️ THE MATH ENGINE PIPELINE
        // ==========================================
        if (!isFollowUp && retrievedCard && retrievedCard.formula_used && retrievedCard.solution_steps) {
            
            const extractorPrompt = `
            You are a math variable extractor. DO NOT SOLVE.
            Question: "${promptText}"
            Formula to use: "${retrievedCard.formula_used}"
            
            Extract the numerical values from the question that match the variables in the formula. Convert to SI units.
            Output ONLY a raw JSON object with variable names as keys and numbers as values. Example: {"k": 400, "r1": 0.1}
            `;

            try {
                // LLM Step 1: Extract Variables
                const extractRes = await fetch(GROQ_URL, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ model: selectedModel, messages: [{ role: "system", content: extractorPrompt }], temperature: 0.1 })
                });
                
                const extractData = await extractRes.json();
                
                if (extractData.choices && extractData.choices[0]) {
                    let rawJsonStr = extractData.choices[0].message.content.replace(/```json/gi, '').replace(/```/g, '').trim();
                    const jsonStart = rawJsonStr.indexOf('{');
                    const jsonEnd = rawJsonStr.lastIndexOf('}');
                    
                    if (jsonStart !== -1 && jsonEnd !== -1) {
                        const variables = JSON.parse(rawJsonStr.substring(jsonStart, jsonEnd + 1));
                        
                        // Backend Math Calculation!
                        computedAnswer = evaluate(retrievedCard.formula_used, variables);
                        computedAnswer = Math.round(computedAnswer * 10000) / 10000; // Round to 4 decimal places
                    }
                }
            } catch (err) {
                console.log("Math Engine Extraction Failed. Error:", err.message);
                // We won't crash here. We just let LLM handle it without computedAnswer
            }

            finalPrompt = `
            You are an elite Engineering Copilot.
            
            Context from Verified Database:
            - Concept: ${retrievedCard.name || retrievedCard.problem || "Concept"}
            - Formula: ${retrievedCard.formula_used}
            - Standard Steps: ${JSON.stringify(retrievedCard.solution_steps)}
            - Common Trap: ${retrievedCard.trap || "None"}
            
            ${computedAnswer !== null ? `CRITICAL INSTRUCTION: The mathematically exact calculated answer is **${computedAnswer}**. You MUST use this exact number as the final answer. Do not recalculate.` : ''}
            
            Generate the final response STRICTLY as a valid JSON object with these keys:
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
            // Normal Follow-Up (ELI5 or Custom Doubt)
            finalPrompt = `You are ExamMind AI, an elite engineering copilot. Answer the user's query clearly and concisely. Context: ${contextData}. DO NOT output JSON, just output plain formatted text.`;
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
        
        // Safety check if Groq API fails
        if (finalData.error) {
            throw new Error(`Groq API Error: ${finalData.error.message}`);
        }
        if (!finalData.choices || !finalData.choices[0]) {
            throw new Error("Received an empty response from Groq AI Server.");
        }

        // Send successful JSON response back to Chrome Extension
        res.status(200).json({
            content: finalData.choices[0].message.content,
            routedTo: selectedModel
        });

    } catch (error) {
        console.error("ExamMind Backend Critical Error:", error.message);
        // 🛡️ CRITICAL FIX: Send proper JSON error back, NEVER HTML.
        res.status(500).json({ error: true, details: error.message });
    }
};
