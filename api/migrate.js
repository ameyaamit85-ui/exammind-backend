const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET request in browser' });

    try {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATION_API_KEY;

        if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
            return res.status(400).json({ error: "Missing Keys in Vercel (Supabase or Gemini)." });
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        
        // 🔥 THE FIX: Using Google's latest active embedding model
        const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

        const DB_URL = "https://raw.githubusercontent.com/ameyaamit85-ui/exammind-data/refs/heads/main/database.json";
        const dbResponse = await fetch(DB_URL);
        const database = await dbResponse.json();

        let successCount = 0;
        let errors = [];

        for (const item of database) {
            try {
                const textToEmbed = `Concept: ${item.name || item.problem}. Description: ${item.desc || ''}. Formula: ${item.formula_used || item.formula || ''}. Keywords: ${item.keywords ? item.keywords.join(', ') : ''}`;

                const result = await embedModel.embedContent(textToEmbed);
                let embedding = result.embedding.values;

                // 🔥 MATRYOSHKA COMPRESSION: Downscale to 768 to perfectly fit your Supabase table
                if (embedding.length > 768) {
                    embedding = embedding.slice(0, 768);
                    // Re-normalize the vector for accurate cosine similarity
                    const mag = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
                    embedding = embedding.map(val => val / mag);
                }

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

                // Free tier limit bachane ke liye pause (500ms)
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                errors.push({ item: item.name || item.problem, error: err.message });
            }
        }

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
