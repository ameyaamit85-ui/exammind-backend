const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// ⚙️ INITIALIZE CLIENTS (No dotenv needed for Vercel)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// ==========================================
// 🔍 1. VECTOR EMBEDDING GENERATOR
// ==========================================
async function getEmbedding(text) {
    try {
        if (!genAI) throw new Error("Gemini API Key missing for embeddings.");
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

    const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
        query_embedding: queryVector,
        match_threshold: 0.5, 
        match_count: 3        
    });

    if (error) {
        console.error("Supabase Search Error:", error.message);
        return "";
    }

    if (documents && documents.length > 0) {
        let contextString = "VERIFIED KNOWLEDGE BASE:\n\n";
        documents.forEach((doc, index) => {
            contextString += `Concept ${index + 1}: ${doc.name}\n`;
            if (doc.desc_text) contextString += `Explanation: ${doc.desc_text}\n`;
            if (doc.formula_used) contextString += `Formula: ${doc.formula_used}\n`;
            contextString += `\n`;
        });
        return contextString;
    }
    return "";
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

        // 📸 IMAGE / VISION LOGIC
        if (isImage && imageData) {
            if (!genAI) throw new Error("Gemini API key missing for Vision.");
            
            // EXACT MODEL AS REQUESTED
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }); 
            
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };

            const imagePrompt = `You are an elite Engineering AI. Analyze this image. If it's a math problem, solve it.
            OUTPUT STRICTLY IN THIS JSON FORMAT ONLY:
            {
                "name": "Short title",
                "problem": "Question text",
                "formula": "LaTeX formula if used",
                "steps": ["Step 1", "Step 2"],
                "answer": "Final answer",
                "desc": "Explanation"
            }`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            return res.status(200).json({ content: result.response.text(), routedTo: "Gemini 3.1 Flash Lite" });
        }

        // 🧠 TEXT LOGIC (THE RAG ENGINE)
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

        // 🔀 SMART ROUTING BASED ON USER CHOICE
        if (modelChoice === "flash-lite") {
            if (!genAI) throw new Error("Gemini API key missing.");
            
            // EXACT MODEL AS REQUESTED
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
            const result = await model.generateContent(finalPrompt);
            responseText = result.response.text();
            engineUsed = "Gemini 3.1 Flash Lite + RAG";
            
        } else {
            if (!GROQ_API_KEY) throw new Error("Groq API key missing.");
            
            // EXACT LLAMA 70B
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: "You output only valid JSON. No preambles." },
                        { role: "user", content: finalPrompt }
                    ],
                    temperature: 0.1
                })
            });
            
            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Groq API Error: ${errorData}`);
            }
            
            const data = await response.json();
            responseText = data.choices[0].message.content;
            engineUsed = "Llama 70B + RAG";
        }

        return res.status(200).json({ content: responseText, routedTo: engineUsed });

    } catch (error) {
        console.error("🔴 API Backend Error:", error.message);
        // Fallback proper JSON error instead of crashing to HTML
        return res.status(500).json({ error: true, details: error.message });
    }
};
