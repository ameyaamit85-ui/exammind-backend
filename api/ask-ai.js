export default async function handler(req, res) {
    // CORS Setup
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

    const { promptText, isFollowUp } = req.body;
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!GROQ_API_KEY) {
        return res.status(500).json({ error: 'BACKEND_SETUP_ERROR', details: 'API Key is missing in Vercel Environment Variables.' });
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama3-8b-8192',
                messages: [{ role: 'user', content: promptText }],
                response_format: isFollowUp ? undefined : { type: 'json_object' } // Fixed this for safety
            })
        });

        if (!response.ok) {
            // Agar Groq fail hota hai, toh wo kya error de raha hai wo hum capture karenge
            const errData = await response.json();
            return res.status(500).json({ error: 'GROQ_API_ERROR', details: errData });
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: 'VERCEL_EXECUTION_ERROR', details: error.message });
    }
}
