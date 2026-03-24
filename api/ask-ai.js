require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// ⚙️ INITIALIZE CLIENTS
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Supabase Setup (Needs URL and SERVICE_ROLE_KEY from Vercel Env)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ==========================================
// 🔍 1. VECTOR EMBEDDING GENERATOR
// ==========================================
async function getEmbedding(text) {
    try {
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values; // Returns the [0.1, 0.4, ...] array
    } catch (error) {
        console.error("Embedding Error:", error);
        return null;
    }
}

// ==========================================
// 📚 2. SUPABASE RAG SEARCH (The Secret Sauce)
// ==========================================
async function fetchVerifiedContext(query) {
    if (!supabase) {
        console.log("⚠️ Supabase not configured in Vercel. Skipping RAG.");
        return "";
    }

    console.log(`🔍 Generating Vector for: "${query.substring(0, 30)}..."`);
    const queryVector = await getEmbedding(query);
    
    if (!queryVector) return "";

    console.log("⚡ Searching Supabase Database...");
    // Call the SQL Function we made earlier
    const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
        query_embedding: queryVector,
        match_threshold: 0.5, // 50% minimum match required
        match_count: 3        // Top 3 best matches
    });

    if (error) {
        console.error("Supabase Search Error:", error.message);
        return "";
    }

    if (documents && documents.length > 0) {
        console.log(`✅ Found ${documents.length} matching verified concepts!`);
        // Combine the matching documents into one context string
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

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: true, message: 'Only POST requests allowed' });
    }

    try {
        const { promptText, isFollowUp, contextData, modelChoice, isImage, imageData } = req.body;

        // 📸 IMAGE / VISION LOGIC (Keep it unchanged, using Gemini Flash Lite)
        if (isImage && imageData) {
            console.log("📸 Processing Image with Gemini Vision...");
            const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash" }); // Or 3.1-flash-lite if you have access
            
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = {
                inlineData: { data: base64Data, mimeType: "image/jpeg" }
            };

            const imagePrompt = `You are an elite Engineering Professor. Analyze this image. If it's a math/engineering problem, solve it.
            OUTPUT STRICTLY IN THIS JSON FORMAT:
            {
                "name": "Short title of the concept",
                "problem": "What the question is asking",
                "formula": "Any LaTeX formula used ($$ formula $$)",
                "steps": ["Step 1...", "Step 2..."],
                "answer": "Final numeric/theoretical answer",
                "desc": "Brief explanation of the core concept"
            }`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            const responseText = result.response.text();

            return res.status(200).json({ content: responseText, routedTo: "Gemini Vision AI" });
        }

        // 🧠 TEXT LOGIC (THE RAG ENGINE)
        
        // Step 1: Fetch Context from Database!
        let verifiedContext = "";
        if (!isFollowUp) {
            verifiedContext = await fetchVerifiedContext(promptText);
        }

        // Step 2: Build the Smart Prompt
        const SYSTEM_PROMPT = `You are an elite Engineering AI.
        OUTPUT STRICTLY AS VALID JSON ONLY. NO MARKDOWN TEXT OUTSIDE JSON.
        Format: {"name":"Topic","desc":"Explanation","formula":"LaTeX $$","steps":["Step 1"],"answer":"Final Answer","trap":"Common mistake"}`;
        
        let finalPrompt = "";
        if (isFollowUp) {
            finalPrompt = `${SYSTEM_PROMPT}\nContext: ${contextData}\nUser Question: ${promptText}`;
        } else {
            // Inject the Database Knowledge into the AI's brain!
            finalPrompt = `${SYSTEM_PROMPT}\n\n${verifiedContext}\n\nSolve this for the user: "${promptText}"\nIMPORTANT: Use the VERIFIED KNOWLEDGE BASE provided above if relevant. Do not hallucinate formulas.`;
        }

        // Step 3: Route to chosen Model (Groq or Gemini)
        let responseText = "";
        let engineUsed = "";

        if (modelChoice === "flash-lite") {
            console.log("⚡ Routing to Gemini...");
            const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash" });
            const result = await model.generateContent(finalPrompt);
            responseText = result.response.text();
            engineUsed = "Gemini Flash + RAG";
        } else {
            console.log("⚡ Routing to Groq (Llama)...");
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
            const data = await response.json();
            responseText = data.choices[0].message.content;
            engineUsed = "Llama 70B + RAG";
        }

        // Return the Smart Answer to the Extension
        return res.status(200).json({ content: responseText, routedTo: engineUsed });

    } catch (error) {
        console.error("🔴 API Error:", error.message);
        return res.status(500).json({ error: true, details: error.message });
    }
};
