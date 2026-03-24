const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// ⚙️ INITIALIZE CLIENTS SAFELY
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Supabase Connection (Only works if keys exist in Vercel)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// ==========================================
// 🔍 1. VECTOR EMBEDDING GENERATOR
// ==========================================
async function getEmbedding(text) {
    try {
        if (!genAI) return null;
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Embedding Error:", error.message);
        return null;
    }
}

// ==========================================
// 📚 2. SUPABASE RAG SEARCH 
// ==========================================
async function fetchVerifiedContext(query) {
    if (!supabase) return "";

    const queryVector = await getEmbedding(query);
    if (!queryVector) return "";

    try {
        const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
            query_embedding: queryVector,
            match_threshold: 0.5, 
            match_count: 3        
        });

        if (error || !documents || documents.length === 0) return "";

        let contextString = "VERIFIED KNOWLEDGE BASE:\n\n";
        documents.forEach((doc, index) => {
            contextString += `Concept ${index + 1}: ${doc.name}\n`;
            if (doc.desc_text) contextString += `Explanation: ${doc.desc_text}\n`;
            if (doc.formula_used) contextString += `Formula: ${doc.formula_used}\n\n`;
        });
        return contextString;
    } catch (err) {
        return "";
    }
}

// ==========================================
// 🚀 3. THE MAIN API HANDLER
// ==========================================
module.exports = async (req, res) => {
    // Enable CORS for Chrome Extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Only POST allowed' });

    try {
        const { promptText, isFollowUp, contextData, modelChoice, isImage, imageData } = req.body;

        // 📸 1. IMAGE / VISION LOGIC (FIXED: Strict Solver Prompt)
        if (isImage && imageData) {
            if (!genAI) return res.status(400).json({ error: true, details: "Gemini API key missing in Vercel." });
            
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }); 
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };

            const imagePrompt = `You are a strict Math & Engineering Solver. Look at the problem in the image and SOLVE IT. 
            DO NOT describe the image. DO NOT talk about AI vision. Provide ONLY the solution steps and final answer.
            OUTPUT STRICTLY IN THIS JSON FORMAT ONLY:
            {
                "name": "Title of the Concept",
                "problem": "The extracted question",
                "formula": "LaTeX formula if used",
                "steps": ["Step 1 calculation", "Step 2 calculation"],
                "answer": "Final exact answer",
                "desc": "Short engineering principle behind the solution"
            }`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            return res.status(200).json({ content: result.response.text(), routedTo: "Gemini 3.1 Flash Lite (Vision)" });
        }

        // 🧠 2. TEXT LOGIC (RAG ENGINE)
        let verifiedContext = "";
        if (!isFollowUp) {
            verifiedContext = await fetchVerifiedContext(promptText);
        }

        const SYSTEM_PROMPT = `You are an elite Engineering AI.
        OUTPUT STRICTLY AS VALID JSON ONLY. NO MARKDOWN TEXT OUTSIDE JSON.
        Format: {"name":"Topic","desc":"Explanation","formula":"LaTeX $$","steps":["Step 1"],"answer":"Final Answer","trap":"Common mistake"}`;
        
        let finalPrompt = isFollowUp 
            ? `${SYSTEM_PROMPT}\nContext: ${contextData}\nUser Question: ${promptText}`
            : `${SYSTEM_PROMPT}\n\n${verifiedContext}\n\nSolve this for the user: "${promptText}"\nIMPORTANT: Use the VERIFIED KNOWLEDGE BASE provided above if relevant. Do not hallucinate.`;

        let responseText = "";
        let engineUsed = "";

        // 🔀 3. SMART ROUTING
        if (modelChoice === "flash-lite") {
            if (!genAI) return res.status(400).json({ error: true, details: "Gemini API key missing." });
            
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
            const result = await model.generateContent(finalPrompt);
            responseText = result.response.text();
            engineUsed = "Gemini 3.1 Flash Lite + RAG";
            
        } else {
            // FIX: Bulletproof Llama 70B Call
            if (!GROQ_API_KEY) return res.status(400).json({ error: true, details: "Groq API key missing in Vercel Environment Variables." });
            
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: "You output only valid JSON. No preambles. Focus on accurate calculations." },
                        { role: "user", content: finalPrompt }
                    ],
                    temperature: 0.1
                })
            });
            
            if (!response.ok) {
                const errorData = await response.text();
                // We return valid JSON even if Groq fails, preventing Vercel HTML crash
                return res.status(500).json({ error: true, details: `Groq AI Error: ${response.statusText}. Please try Gemini instead.` });
            }
            
            const data = await response.json();
            responseText = data.choices[0].message.content;
            engineUsed = "Llama 3.3 70B + RAG";
        }

        return res.status(200).json({ content: responseText, routedTo: engineUsed });

    } catch (error) {
        console.error("🔴 API Backend Error:", error.message);
        // Guarantee JSON output on global crash
        return res.status(500).json({ error: true, details: error.message });
    }
};
