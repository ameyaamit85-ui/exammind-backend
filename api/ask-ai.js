export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

        if (!GROQ_API_KEY || !GEMINI_API_KEY) {
            return res.status(500).json({ error: 'VERCEL_ERROR', details: 'API Keys missing' });
        }

        const { promptText, isFollowUp, contextData, modelChoice } = req.body;

        let finalPrompt = promptText;
        if (contextData) {
            finalPrompt += `\n\nCRITICAL EXAMMIND DATABASE CONTEXT: ${contextData}. You MUST ground your explanation and formula using this verified data to ensure 100% accuracy.`;
        }

        // =========================================================
        // 🧠 THE EXACT MODEL ROUTER (FIXED FOR 3.1)
        // =========================================================
        let engine = 'groq'; 
        let specificModel = 'llama-3.3-70b-versatile'; 

        if (modelChoice === 'flash-lite') {
            engine = 'gemini';
            specificModel = 'gemini-3.1-flash-lite'; // 🔥 FIXED: EXACTLY 3.1
        } 
        else if (modelChoice === 'gemini') {
            engine = 'gemini';
            specificModel = 'gemini-3.1-flash'; // 🔥 UPGRADED PRO TO 3.1 AS WELL
        } 
        else if (modelChoice === 'llama' || modelChoice === 'llama-8b') {
            engine = 'groq';
            specificModel = 'llama-3.1-8b-instant';
        } 
        else if (modelChoice === 'gemma') {
            engine = 'groq';
            specificModel = 'gemma-3-2b-it'; // 🔥 EXACT GEMMA 3
        } 
        else if (modelChoice === 'auto') {
            if (/\d/.test(promptText) && /calculate|find|determine|value|equation|evaluate/i.test(promptText)) {
                engine = 'gemini';
                specificModel = 'gemini-3.1-flash';
            }
        }

        // =========================================================
        // 🚀 EXECUTION LOGIC
        // =========================================================
        let aiResultData;

        if (engine === 'gemini') {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${specificModel}:generateContent?key=${GEMINI_API_KEY}`;
            
            const geminiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: finalPrompt }] }],
                    generationConfig: { responseMimeType: isFollowUp ? "text/plain" : "application/json" }
                })
            });

            const geminiData = await geminiResponse.json();
            
            // Check for API errors
            if (geminiData.error) {
                 throw new Error(`Gemini API Error: ${geminiData.error.message}`);
            }
            
            aiResultData = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!aiResultData) throw new Error(`${specificModel} returned an empty response.`);
            
        } else {
            const groqBody = {
                model: specificModel, 
                messages: [{ role: 'user', content: finalPrompt }],
                max_tokens: 3000
            };
            if (!isFollowUp) groqBody.response_format = { type: 'json_object' };

            const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(groqBody)
            });

            const groqData = await groqResponse.json();
            
            if (groqData.error) {
                 throw new Error(`Groq API Error: ${groqData.error.message}`);
            }
            
            aiResultData = groqData?.choices?.[0]?.message?.content;
            if (!aiResultData) throw new Error(`${specificModel} returned an empty response.`);
        }

        return res.status(200).json({ 
            content: aiResultData, 
            routedTo: specificModel 
        });

    } catch (error) {
        return res.status(500).json({ error: 'ROUTING_ENGINE_CRASH', details: error.toString() });
    }
}
