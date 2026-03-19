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
        let finalPrompt = promptText;
        if (contextData) {
            finalPrompt += `\n\nCRITICAL CONTEXT: ${contextData}. Use this verified data.`;
        }

        // 🔥 EXACT WORKING ENDPOINTS ONLY
        let engine = 'groq'; 
        let specificModel = 'llama-3.3-70b-versatile'; 

        if (modelChoice === 'flash-lite') { 
            engine = 'gemini'; 
            specificModel = 'gemini-1.5-flash'; // Most stable, lowest latency endpoint
        } 
        else if (modelChoice === 'llama-70b') { 
            engine = 'groq'; 
            specificModel = 'llama-3.3-70b-versatile'; 
        }

        let aiResultData;

        try {
            if (engine === 'gemini') {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${specificModel}:generateContent?key=${GEMINI_API_KEY}`;
                const response = await fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }] })
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message);
                aiResultData = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            } else {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: specificModel, messages: [{ role: 'user', content: finalPrompt }] })
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message);
                aiResultData = data?.choices?.[0]?.message?.content;
            }
        } catch (primaryError) {
            // 🛡️ ROCK-SOLID FALLBACK (NO GEMINI-PRO)
            console.log("Primary failed, using Groq 8B Fallback:", primaryError.message);
            const fbRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: finalPrompt }] })
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
