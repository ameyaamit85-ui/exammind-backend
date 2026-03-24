const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

// ⚙️ INITIALIZE CLIENTS
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; 
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// ==========================================
// 🔍 1. VECTOR EMBEDDING (For Gemini Only)
// ==========================================
async function getEmbedding(text) {
    try {
        if (!genAI) return null;
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        return null;
    }
}

async function fetchVerifiedContext(query) {
    if (!supabase) return "";
    const queryVector = await getEmbedding(query);
    if (!queryVector) return "";

    try {
        const { data: documents, error } = await supabase.rpc('match_verified_concepts', {
            query_embedding: queryVector, match_threshold: 0.5, match_count: 3        
        });
        if (error || !documents || documents.length === 0) return "";

        let contextString = "VERIFIED KNOWLEDGE BASE:\n\n";
        documents.forEach((doc, index) => {
            contextString += `Concept ${index + 1}: ${doc.name}\nExplanation: ${doc.desc_text}\nFormula: ${doc.formula_used}\n\n`;
        });
        return contextString;
    } catch (err) { return ""; }
}

// ==========================================
// 🚀 2. THE MAIN API HANDLER
// ==========================================
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Only POST allowed' });

    try {
        const { promptText, isFollowUp, contextData, modelChoice, isImage, imageData } = req.body;

        // 📸 A. IMAGE / VISION LOGIC (Fixed LaTeX Tags)
        if (isImage && imageData) {
            if (!genAI) return res.status(400).json({ error: true, details: "Gemini API key missing." });
            
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }); 
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };

            const imagePrompt = `You are a strict Engineering Solver. Look at the problem and SOLVE IT directly.
            OUTPUT ONLY VALID JSON. DO NOT use markdown code blocks (\`\`\`json).
            {
                "name": "Topic Title",
                "problem": "Question text",
                "formula": "$$ \\text{Formula here} $$", 
                "steps": ["Step 1", "Step 2"],
                "answer": "Final numeric answer",
                "desc": "Short explanation"
            }
            CRITICAL: You MUST wrap any formula with $$ at the beginning and end.`;

            const result = await model.generateContent([imagePrompt, imagePart]);
            return res.status(200).json({ content: result.response.text(), routedTo: "Gemini 3.1 Flash Lite" });
        }

        // 🧠 B. FOLLOW-UP LOGIC (ELI5 / Deep Dive) - NO JSON HERE!
        if (isFollowUp) {
            const followUpPrompt = `You are an expert Engineering Tutor.
            Context regarding the topic: ${contextData}
            User Request: ${promptText}
            Provide a clear, plain-text response. Do NOT output JSON. Use LaTeX $$ for math if needed.`;

            if (modelChoice === "flash-lite") {
                const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
                const result = await model.generateContent(followUpPrompt);
                return res.status(200).json({ content: result.response.text(), routedTo: "Gemini 3.1 Flash Lite" });
            } else {
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: "You are a helpful engineering tutor." },
                            { role: "user", content: followUpPrompt }
                        ]
                    })
                });
                const data = await response.json();
                return res.status(200).json({ content: data.choices[0].message.content, routedTo: "Llama 3.3 70B" });
            }
        }

        // 📚 C. MAIN TEXT LOGIC (With User's Cache Rules)
        const SYSTEM_PROMPT = `You are an elite Engineering AI. Output ONLY valid JSON.
        Format: {"name":"Topic","desc":"Explanation","formula":"$$ LaTeX $$","steps":["Step 1"],"answer":"Final Answer","trap":"Common mistake"}`;
        
        let finalPrompt = "";
        let responseText = "";
        let engineUsed = "";

        if (modelChoice === "flash-lite") {
            // GEMINI GETS THE RAG CACHE
            const verifiedContext = await fetchVerifiedContext(promptText);
            finalPrompt = `${SYSTEM_PROMPT}\n\n${verifiedContext}\n\nSolve this for the user: "${promptText}"\nIMPORTANT: Use the VERIFIED KNOWLEDGE BASE if relevant.`;
            
            const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
            const result = await model.generateContent(finalPrompt);
            responseText = result.response.text();
            engineUsed = "Gemini 3.1 Flash Lite + RAG";
            
        } else {
            // LLAMA 70B GETS PURE SOLVER MODE (NO CACHE)
            finalPrompt = `${SYSTEM_PROMPT}\n\nSolve this purely based on your engineering knowledge: "${promptText}"`;
            
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: "You output only valid JSON." },
                        { role: "user", content: finalPrompt }
                    ],
                    response_format: { type: "json_object" }, // THIS GUARANTEES IT WON'T BREAK
                    temperature: 0.1
                })
            });
            const data = await response.json();
            responseText = data.choices[0].message.content;
            engineUsed = "Llama 3.3 70B (Pure)";
        }

        return res.status(200).json({ content: responseText, routedTo: engineUsed });

    } catch (error) {
        console.error("🔴 API Error:", error.message);
        return res.status(500).json({ error: true, details: error.message });
    }
};
