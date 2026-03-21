const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function handler(req, res) {
    // Sirf GET request allow karenge taaki browser se hit kar sakein
    if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET request in browser' });

    try {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATION_API_KEY;

        if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
            return res.status(400).json({ error: "Missing Keys in Vercel (Supabase or Gemini)." });
        }

        // Initialize Clients
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // 🔥 Using Google's specialized embedding model
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

        // 1. Fetch current database from your GitHub
        const DB_URL = "https://raw.githubusercontent.com/ameyaamit85-ui/exammind-data/refs/heads/main/database.json";
        const dbResponse = await fetch(DB_URL);
        const database = await dbResponse.json();

        let successCount = 0;
        let errors = [];

        // 2. Vectorize and Push to Supabase
        for (const item of database) {
            try {
                // Ye AI ke samajhne ke liye context string hai
                const textToEmbed = `Concept: ${item.name || item.problem}. Description: ${item.desc || ''}. Formula: ${item.formula_used || item.formula || ''}. Keywords: ${item.keywords ? item.keywords.join(', ') : ''}`;

                // Gemini se is text ka "Vector/Meaning" nikalo
                const result = await embedModel.embedContent(textToEmbed);
                const embedding = result.embedding.values;

                // Supabase ki nayi table mein push karo
                const { error } = await supabase
                    .from('verified_concepts')
                    .insert({
                        name: item.name || item.problem || 'Unknown',
                        desc_text: item.desc || '',
                        formula_used: item.formula_used || item.formula || '',
                        solution_steps: item.solution_steps || item.steps || [],
                        final_answer: item.final_answer || item.answer || '',
                        trap: item.trap || '',
                        concept_type: item.type || 'concept',
                        embedding: embedding
                    });

                if (error) throw error;
                successCount++;

                // Free tier limit bachane ke liye chota sa pause (500ms)
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                errors.push({ item: item.name, error: err.message });
            }
        }

        // Return final report
        return res.status(200).json({
            success: true,
            message: `MISSION SUCCESS! 🔥 ${successCount} concepts vectorized and uploaded to Supabase.`,
            errors: errors
        });

    } catch (error) {
        console.error("Migration Error:", error);
        return res.status(500).json({ error: true, details: error.message });
    }
};
