export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Google AI Studio se banayi hui key

        if (!GROQ_API_KEY || !GEMINI_API_KEY) {
            return res.status(500).json({ error: 'VERCEL_ERROR', details: 'API Keys are missing in Vercel settings.' });
        }

        const { promptText, isFollowUp } = req.body;

        // 🔥 THE CLASSIFIER: Check if it's a numerical problem
        const isNumerical = /\d/.test(promptText) && /calculate|find|determine|value|equation|evaluate/i.test(promptText);

        let aiResultData;

        if (isNumerical) {
            // 🚀 ROUTE 1: HARD MATH -> Send to Gemini 2.5 Flash
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
            
            // For Gemini, we pass the prompt directly
            const geminiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }],
                    generationConfig: { responseMimeType: isFollowUp ? "text/plain" : "application/json" }
                })
            });

            if (!geminiResponse.ok) {
                const err = await geminiResponse.text();
                throw new Error(`Gemini Failed: ${err}`);
            }
            
            const geminiData = await geminiResponse.json();
            aiResultData = geminiData.candidates[0].content.parts[0].text;
            
        } else {
            // 🚀 ROUTE 2: THEORY & CONCEPTS -> Send to Groq Llama (Super Fast)
            const groqBody = {
                model: 'llama-3.3-70b-versatile', 
                messages: [{ role: 'user', content: promptText }],
                max_tokens: 3000 // 🔥 FIX for the "Max Tokens Reached" error!
            };
            if (!isFollowUp) groqBody.response_format = { type: 'json_object' };

            const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(groqBody)
            });

            if (!groqResponse.ok) {
                const err = await groqResponse.text();
                throw new Error(`Groq Failed: ${err}`);
            }
            const groqData = await groqResponse.json();
            aiResultData = groqData.choices[0].message.content;
        }

        return res.status(200).json({ content: aiResultData, routedTo: isNumerical ? 'Gemini 2.5 Flash' : 'Groq Llama' });

    } catch (error) {
        return res.status(500).json({ error: 'ROUTING_ENGINE_CRASH', details: error.toString() });
    }
}
