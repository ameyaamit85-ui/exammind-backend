// File: api/ask-ai.js
const cors = require('cors')({ origin: '*' }); // Baad me isko apne extension ki ID se lock kar denge

export default async function handler(req, res) {
    // Handle CORS preflight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

        const { promptText, isFollowUp } = req.body;
        
        // Vercel dashboard me hum ye secret key daalenge
        const GROQ_API_KEY = process.env.GROQ_API_KEY; 

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
                    // Follow-up queries ko plain text chahiye, main queries ko JSON
                    response_format: isFollowUp ? { type: 'text' } : { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(err);
            }

            const data = await response.json();
            res.status(200).json(data);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Server Error' });
        }
    });
}