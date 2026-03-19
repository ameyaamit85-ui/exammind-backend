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
        
        // 🔥 BILLION DOLLAR PROMPT ENGINEERING (GATE, JEE, UPSC LEVEL)
        let finalPrompt = `You are an Elite Professor and AI Copilot for GATE (All Branches), JEE Advanced, and UPSC aspirants. The user asked: "${promptText}".\n`;
        
        if (contextData) {
            finalPrompt += `CRITICAL CONTEXT: ${contextData}. Use this verified data.\n`;
        }

        finalPrompt += `
        CRITICAL FORMATTING RULES (FAILURE IS NOT AN OPTION):
        1. "answer": MUST be strictly max 2 to 5 words! ONLY the final numerical value, core formula, or key term. NEVER write sentences here.
        2. "desc": Provide a highly professional, detailed 3-4 sentence explanation.
        3. "trap": Explain the common student mistake deeply (at least 2-3 sentences). Don't just give 3 words. Tell them WHY students fail here.
        4. "formula": The core mathematical equation used.
        5. DO NOT USE LaTeX. Use plain text (e.g., 1/r^2).
        6. Output strictly valid JSON without trailing commas. Keys: hidden_scratchpad, formula, answer, confidence, is_match, desc, trap, steps (array of detailed strings).`;

        let engine = 'groq'; 
        let specificModel = 'llama-3.3-70b-versatile'; 

        if (modelChoice === 'flash-lite') { 
            engine = 'gemini'; 
            specificModel = 'gemini-1.5-flash'; 
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
