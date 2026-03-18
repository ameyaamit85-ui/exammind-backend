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

        // 🚀 Frontend ab bheja karega 'modelChoice' (groq ya gemini)
        const { promptText, isFollowUp, contextData, modelChoice } = req.body;

        let finalPrompt = promptText;
        if (contextData) {
            finalPrompt += `\n\nCRITICAL EXAMMIND DATABASE CONTEXT: ${contextData}. You MUST ground your explanation and formula using this verified data to ensure 100% accuracy.`;
        }

        // 🧠 NAYA LOGIC: User Control > Auto Router
        let useGemini = false;
        if (modelChoice === 'gemini') {
            useGemini = true;
        } else if (modelChoice === 'groq') {
            useGemini = false;
        } else {
            // Agar user ne select nahi kiya, tabhi Auto-Route karo
            useGemini = /\d/.test(promptText) && /calculate|find|determine|value|equation|evaluate/i.test(promptText);
        }

        let aiResultData;

        if (useGemini) {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
            const geminiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: finalPrompt }] }],
                    generationConfig: { responseMimeType: isFollowUp ? "text/plain" : "application/json" }
                })
            });

            const geminiData = await geminiResponse.json();
            aiResultData = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!aiResultData) throw new Error('Gemini returned an empty response.');
            
        } else {
            const groqBody = {
                model: 'llama-3.3-70b-versatile', 
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
            aiResultData = groqData?.choices?.[0]?.message?.content;
            if (!aiResultData) throw new Error('Groq returned an empty response.');
        }

        return res.status(200).json({ content: aiResultData, routedTo: useGemini ? 'Gemini 2.5 Flash' : 'Llama 3.3 70B' });

    } catch (error) {
        return res.status(500).json({ error: 'ROUTING_ENGINE_CRASH', details: error.toString() });
    }
}
