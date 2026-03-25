const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// 🧠 UPGRADE 1: API Key Rotation Hack (Load Balancing)
function getGenAI() {
    const apiKeys = [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3
    ].filter(Boolean); // Removes empty variables

    if (apiKeys.length === 0) return null;
    const randomKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    return new GoogleGenerativeAI(randomKey);
}

async function getEmbedding(text) {
    try {
        const genAI = getGenAI();
        if (!genAI) return null;
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) { return null; }
}

// 🛡️ UPGRADE 2: Optimized RAG Fetching (Egress Protection)
async function fetchVerifiedContext(query, branch) {
    if (!supabase) return "";
    const queryVector = await getEmbedding(query);
    if (!queryVector) return "";
    try {
        const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
            query_embedding: queryVector, 
            match_threshold: 0.5, 
            match_count: 3,
            target_branch: branch 
        }).select('name, desc_text, formula_used'); // 🔥 Strict selection to save Egress!

        if (error || !documents || documents.length === 0) return "";

        let contextString = "VERIFIED KNOWLEDGE BASE:\n\n";
        documents.forEach((doc, index) => {
            contextString += `Concept ${index + 1}: ${doc.name}\nExplanation: ${doc.desc_text}\nFormula: ${doc.formula_used}\n\n`;
        });
        return contextString;
    } catch (err) { return ""; }
}

// ⚡ UPGRADE 3: Supabase Caching Engine
async function checkCache(query) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('ai_cache')
            .select('response')
            .eq('query', query.trim().toLowerCase())
            .limit(1)
            .single();
        if (data && data.response) return data.response;
    } catch (err) { return null; }
    return null;
}

async function saveCache(query, responseText) {
    if (!supabase) return;
    try {
        await supabase.from('ai_cache').insert([{
            query: query.trim().toLowerCase(),
            response: responseText
        }]);
    } catch (err) { /* Silently ignore duplicate errors */ }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Only POST allowed' });

    try {
        const { promptText, isFollowUp, contextData, modelChoice, isImage, imageData, branch } = req.body;
        const currentBranch = branch || "Chemical"; 

        const genAI = getGenAI();

        // ⚡ CACHE CHECK (Bypass API if already answered)
        if (!isImage && !isFollowUp && promptText) {
            const cachedAnswer = await checkCache(promptText);
            if (cachedAnswer) {
                return res.status(200).json({ content: cachedAnswer, routedTo: "ExamMind Core (⚡ Cached)" });
            }
        }

        // 📸 1. VISION AI
        if (isImage && imageData) {
            if (!genAI) return res.status(400).json({ error: true, details: "Gemini API key missing." });
            
            // 🔥 Forced strictly to 3.1 flash lite preview
            const model = genAI.getGenerativeModel({ 
                model: "gemini-3.1-flash-lite-preview",
                generationConfig: { responseMimeType: "application/json" }
            }); 
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };

            // 🔥 TRAP ADDED TO VISION PROMPT
            const imagePrompt = `You are a strict ${currentBranch} Engineering Solver. Look at the problem and SOLVE IT.
            OUTPUT ONLY VALID JSON.
            {
                "name": "Topic Title",
                "problem": "Question text",
                "formula": "$$ \\text{Formula here} $$", 
                "steps": ["Step 1", "Step 2"],
                "answer": "Final numeric answer",
                "desc": "Short explanation",
                "trap": "Identify a common student mistake or calculation trap here"
            }`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            return res.status(200).json({ content: result.response.text(), routedTo: "ExamMind Vision AI" }); // 🍏 Custom Branding
        }

        // 🧠 2. FOLLOW-UP LOGIC (Llama 70B - Untouched)
        if (isFollowUp) {
            const followUpPrompt = `Context: ${contextData}\nUser Request: ${promptText}\nProvide a clear, plain-text response. Do NOT output JSON. Use LaTeX $$ for math if needed.`;
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [ { role: "system", content: `You are an elite ${currentBranch} engineering tutor.` }, { role: "user", content: followUpPrompt } ]
                })
            });
            const data = await response.json();
            return res.status(200).json({ content: data.choices[0].message.content, routedTo: "ExamMind Core" }); // 🍏 Custom Branding
        }

        // 🚀 3. MAIN SOLVER LOGIC
        // 🔥 Forced strictly to 3.1 flash lite preview
        let actualModelStr = "gemini-3.1-flash-lite-preview"; 

        const verifiedContext = await fetchVerifiedContext(promptText, currentBranch);
        
        const SYSTEM_PROMPT = `You are an elite ${currentBranch} Engineering AI. 
        Use the provided VERIFIED KNOWLEDGE BASE as your primary reference. 
        HOWEVER, if you detect an obvious mathematical error, formula mismatch, or violation of core engineering principles in the knowledge base, YOU MUST CORRECT IT in your final output. Trust your fundamental training over flawed data.
        Output ONLY valid JSON.
        Format: {"name":"Topic","desc":"Explanation","formula":"$$ LaTeX $$","steps":["Step 1"],"answer":"Final Answer","trap":"Common mistake"}`;
        
        const finalPrompt = `${SYSTEM_PROMPT}\n\n${verifiedContext}\n\nSolve this query dynamically based on engineering principles: "${promptText}"`;
        
        const model = genAI.getGenerativeModel({ 
            model: actualModelStr,
            generationConfig: { responseMimeType: "application/json" }
        });
        const result = await model.generateContent(finalPrompt);
        const finalText = result.response.text();

        // ⚡ SAVE NEW ANSWER TO CACHE
        await saveCache(promptText, finalText);

        return res.status(200).json({ content: finalText, routedTo: "ExamMind Core" }); // 🍏 Custom Branding

    } catch (error) {
        console.error("🔴 API Error:", error.message);
        return res.status(500).json({ error: true, details: error.message });
    }
};
