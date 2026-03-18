export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

    try {
        const GROQ_API_KEY = process.env.GROQ_API_KEY;
        if (!GROQ_API_KEY) {
            return res.status(500).json({ error: 'VERCEL_ERROR', details: 'API Key missing' });
        }

        const { promptText, isFollowUp } = req.body;
        
        // 🚀 THE UPGRADE: Changed from 8B to the massive 70B Model for heavy Engineering Math!
        const bodyData = {
            model: 'llama-3.3-70b-versatile', 
            messages: [{ role: 'user', content: promptText }]
        };
        
        if (!isFollowUp) bodyData.response_format = { type: 'json_object' };

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bodyData)
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(500).json({ error: 'GROQ_API_ERROR', details: errText });
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: 'VERCEL_CRASH', details: error.toString() });
    }
}
