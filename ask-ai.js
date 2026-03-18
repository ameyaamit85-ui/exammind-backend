export default async function handler(req, res) {
    // 1. Manually Setting CORS (Bulletproof, no external package needed)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight security check from browser
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Reject non-POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Only POST allowed' });
    }

    const { promptText, isFollowUp } = req.body;
    
    // Fetching the Secret Key from Vercel
    const GROQ_API_KEY = process.env.GROQ_API_KEY;

    if (!GROQ_API_KEY) {
        return res.status(500).json({ error: 'API Key missing in Vercel settings!' });
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
                response_format: isFollowUp ? { type: 'text' } : { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText);
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        console.error("Groq Error:", error);
        return res.status(500).json({ error: 'Groq API failed' });
    }
}
