const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

async function getEmbedding(text) {
    try {
        if (!genAI) return null;
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) { return null; }
}

// 🧠 NEW: Added 'branch' parameter for Smart RAG Routing
async function fetchVerifiedContext(query, branch) {
    if (!supabase) return "";
    const queryVector = await getEmbedding(query);
    if (!queryVector) return "";
    try {
        const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
            query_embedding: queryVector, 
            match_threshold: 0.5, 
            match_count: 3,
            target_branch: branch // 🔥 Filter by User's Branch!
        });
        if (error || !documents || documents.length === 0) return "";

        let contextString = "VERIFIED KNOWLEDGE BASE:\n\n";
        documents.forEach((doc, index) => {
            contextString += `Concept ${index + 1}: ${doc.name}\nExplanation: ${doc.desc_text}\nFormula: ${doc.formula_used}\n\n`;
        });
        return contextString;
    } catch (err) { return ""; }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Only POST allowed' });

    try {
        // 🧠 NEW: Extracting 'branch' from the request
        const { promptText, isFollowUp, contextData, modelChoice, isImage, imageData, branch } = req.body;
        const currentBranch = branch || "Chemical"; // Default safety fallback

        // 📸 1. VISION AI
        if (isImage && imageData) {
            if (!genAI) return res.status(400).json({ error: true, details: "Gemini API key missing." });
            
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                generationConfig: { responseMimeType: "application/json" }
            }); 
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };

            const imagePrompt = `You are a strict ${currentBranch} Engineering Solver. Look at the problem and SOLVE IT.
            OUTPUT ONLY VALID JSON.
            {
                "name": "Topic Title",
                "problem": "Question text",
                "formula": "$$ \\text{Formula here} $$", 
                "steps": ["Step 1", "Step 2"],
                "answer": "Final numeric answer",
                "desc": "Short explanation"
            }`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            return res.status(200).json({ content: result.response.text(), routedTo: "Gemini 2.5 Flash (Vision)" });
        }

        // 🧠 2. FOLLOW-UP LOGIC (Llama 70B)
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
            return res.status(200).json({ content: data.choices[0].message.content, routedTo: "Llama 3.3 70B (Theory)" });
        }

        // 🚀 3. MAIN SOLVER LOGIC
        let actualModelStr = "gemini-2.5-flash"; 
        if (modelChoice === "gemini-3.1-flash-lite") actualModelStr = "gemini-3.1-flash-lite-preview";
        else if (modelChoice === "gemini-3-flash") actualModelStr = "gemini-3.0-flash";
        else if (modelChoice === "gemini-2.5-flash") actualModelStr = "gemini-2.5-flash";
        else if (modelChoice === "gemini-2.5-flash-lite") actualModelStr = "gemini-2.5-flash-lite";

        // 🔥 Passing branch to RAG function
        const verifiedContext = await fetchVerifiedContext(promptText, currentBranch);
        
        // 🔥 Dynamic System Prompt Based on Branch
        const SYSTEM_PROMPT = `You are an elite ${currentBranch} Engineering AI. Output ONLY valid JSON.
        Format: {"name":"Topic","desc":"Explanation","formula":"$$ LaTeX $$","steps":["Step 1"],"answer":"Final Answer","trap":"Common mistake"}`;
        
        const finalPrompt = `${SYSTEM_PROMPT}\n\n${verifiedContext}\n\nSolve this query dynamically based on engineering principles: "${promptText}"`;
        
        const model = genAI.getGenerativeModel({ 
            model: actualModelStr,
            generationConfig: { responseMimeType: "application/json" }
        });
        const result = await model.generateContent(finalPrompt);
        
        return res.status(200).json({ content: result.response.text(), routedTo: `${actualModelStr} + RAG` });

    } catch (error) {
        console.error("🔴 API Error:", error.message);
        return res.status(500).json({ error: true, details: error.message });
    }
};
