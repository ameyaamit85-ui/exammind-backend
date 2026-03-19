export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

        const { promptText, isFollowUp, contextData, modelChoice } = req.body;
        
        let finalPrompt = "";

        if (!isFollowUp) {
            finalPrompt = `You are an Elite Professor and AI Copilot for competitive exams like GATE, JEE Advanced, and UPSC. The user asked: "${promptText}".\n`;
            if (contextData) {
                finalPrompt += `CRITICAL CONTEXT: ${contextData}. Use this verified data.\n`;
            }
            finalPrompt += `
            CRITICAL FORMATTING RULES:
            1. "answer": strictly max 2 to 5 words! ONLY the final numerical value or core concept.
            2. "desc": Detailed 3-4 sentence explanation.
            3. "trap": Explain the common student mistake deeply.
            4. "formula": The core mathematical equation used.
            5. DO NOT USE LaTeX. Use plain text (e.g., 1/r^2).
            6. Output strictly in JSON format. Keys MUST BE EXACTLY: 
            {
              "hidden_scratchpad": "...",
              "formula": "...",
              "answer": "...",
              "confidence": "High/Medium/Low",
              "is_match": true/false,
              "desc": "...",
              "trap": "...",
              "steps": ["step 1", "step 2"] // MUST BE A JSON ARRAY OF STRINGS. DO NOT OUTPUT A SINGLE STRING.
            }`;
        } else {
            finalPrompt = `You are an Elite Academic AI Tutor. Task: "${promptText}"\nContext: "${contextData}"\nIMPORTANT: Output plain text ONLY. DO NOT output JSON. Provide a highly professional explanation.`;
        }

        let engine = 'groq'; 
        let specificModel = 'llama-3.3-70b-versatile'; 

        if (modelChoice === 'flash-lite') { 
            engine = 'gemini'; 
            specificModel = 'gemini-3.1-flash-lite-preview'; 
        } 
        else if (modelChoice === 'llama-70b') { 
            engine = 'groq'; 
            specificModel = 'llama-3.3-70b-versatile'; 
        }

        let aiResultData;

        try {
            if (engine === 'gemini') {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${specificModel}:generateContent?key=${GEMINI_API_KEY}`;
                const reqBody = { contents: [{ parts: [{ text: finalPrompt }] }] };
                if (!isFollowUp) reqBody.generationConfig = { responseMimeType: "application/json" };

                const response = await fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody)
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message);
                aiResultData = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            } else {
                const groqBody = { model: specificModel, messages: [{ role: 'user', content: finalPrompt }] };
                if (!isFollowUp) groqBody.response_format = { type: 'json_object' };

                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(groqBody)
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message);
                aiResultData = data?.choices?.[0]?.message?.content;
            }
        } catch (primaryError) {
            console.log("Primary failed, using Groq Fallback:", primaryError.message);
            const fbBody = { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: finalPrompt }] };
            if (!isFollowUp) fbBody.response_format = { type: 'json_object' };
            
            const fbRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(fbBody)
            });
            const fbData = await fbRes.json();
            aiResultData = fbData?.choices?.[0]?.message?.content;
            specificModel = 'llama-3.1-8b-instant (Fallback)';
        }

        if (!aiResultData) throw new Error("AI generated an empty response.");
        return res.status(200).json({ content: aiResultData, routedTo: specificModel });

    } catch (error) {
        return res.status(500).json({ error: 'SERVER_ERROR', details: error.message });
    }
}
