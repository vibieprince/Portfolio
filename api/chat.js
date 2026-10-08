// api/chat.js - Production Portfolio Chatbot Endpoint with RAG & Gemini -> Mistral Fallback

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  console.log("[CHAT] Request received at /api/chat");

  // Environment Variables
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

  const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || "gemini-embedding-2";
  const EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || "768", 10);
  const GEMINI_LLM_MODEL = process.env.GEMINI_LLM_MODEL || process.env.LLM_MODEL || "gemini-3.5-flash-lite";
  const MISTRAL_LLM_MODEL = process.env.MISTRAL_LLM_MODEL || "mistral-small-latest";

  // Validate Server Credentials
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
    console.error("[CHAT ERROR] Server configuration missing required environment variables.");
    return res.status(500).json({
      error: "Server configuration missing required environment variables.",
      details: {
        GEMINI_API_KEY: !!GEMINI_API_KEY,
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY
      }
    });
  }

  try {
    const { message, conversation = [], pageContext = {} } = req.body || {};

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message parameter is required." });
    }

    const userQuery = message.trim().slice(0, 1000);
    const recentHistory = Array.isArray(conversation) ? conversation.slice(-8) : [];

    // STEP 1: Standalone Search Query Reformulation
    let retrievalQuery = userQuery;

    if (recentHistory.length > 0) {
      console.log("[CHAT] Step 1: Reformulating context-aware standalone search query...");
      const historyText = recentHistory
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");

      const queryReformPrompt = `Given the following conversation history and a follow-up message, rephrase the follow-up message into a concise standalone search query that preserves all implicit context, pronouns (it, that project, second one, score), and entities.

CONVERSATION HISTORY:
${historyText}

FOLLOW-UP MESSAGE:
${userQuery}

STANDALONE SEARCH QUERY:`;

      try {
        const reformRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LLM_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: queryReformPrompt }] }],
              generationConfig: { maxOutputTokens: 100, temperature: 0.1 }
            })
          }
        );

        if (reformRes.ok) {
          const reformData = await reformRes.json();
          const standaloneText = reformData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (standaloneText && standaloneText.trim()) {
            retrievalQuery = standaloneText.trim();
            console.log(`[CHAT] Query reformulated to: "${retrievalQuery}"`);
          }
        }
      } catch (err) {
        console.warn("[CHAT WARN] Query reform fetch failed, using raw query:", err.message);
      }
    }

    // STEP 2: Generate Vector Query Embedding (Gemini)
    console.log(`[CHAT] Step 2: Generating query embedding via ${EMBEDDING_MODEL}...`);
    let queryVector = null;

    try {
      const embedRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: retrievalQuery }] },
            taskType: "RETRIEVAL_QUERY",
            outputDimensionality: EMBEDDING_DIMENSION
          })
        }
      );

      if (!embedRes.ok) {
        const errText = await embedRes.text();
        console.error(`[CHAT ERROR] Gemini Embedding API returned HTTP ${embedRes.status}:`, errText);
        throw new Error(`Gemini Embedding API returned ${embedRes.status}: ${errText}`);
      }

      const embedData = await embedRes.json();
      queryVector = embedData?.embedding?.values;
      console.log(`[CHAT] Embedding generated successfully (${queryVector ? queryVector.length : 0} dims).`);
    } catch (embedError) {
      console.error("[CHAT ERROR] Gemini Embedding service failed:", embedError.message);
      return res.status(502).json({
        error: "Failed to communicate with Gemini Embedding service.",
        details: embedError.message
      });
    }

    // STEP 3: Search Supabase pgvector Vector Database
    console.log("[CHAT] Step 3: Querying Supabase pgvector RPC match_documents...");
    let retrievedChunks = [];

    try {
      const supabaseRpcUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/match_documents`;
      const rpcRes = await fetch(supabaseRpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          query_embedding: queryVector,
          match_threshold: 0.15,
          match_count: 6
        })
      });

      if (!rpcRes.ok) {
        const rpcErr = await rpcRes.text();
        console.error(`[CHAT ERROR] Supabase RPC returned HTTP ${rpcRes.status}:`, rpcErr);
        throw new Error(`Supabase RPC returned ${rpcRes.status}: ${rpcErr}`);
      }

      retrievedChunks = await rpcRes.json();
      console.log(`[CHAT] Supabase search completed. Retrieved ${retrievedChunks.length} chunks.`);
    } catch (rpcError) {
      console.error("[CHAT ERROR] Supabase RPC fetch failed:", rpcError.message);
      return res.status(502).json({
        error: "Failed to connect to Supabase vector database.",
        details: rpcError.message
      });
    }

    // Deduplicate and Format Context and Source Citations
    const sourcesMap = new Map();
    const contextTexts = [];

    if (Array.isArray(retrievedChunks) && retrievedChunks.length > 0) {
      retrievedChunks.forEach((chunk) => {
        const meta = chunk.metadata || {};
        const sourceLabel = meta.entity ? `${meta.section} — ${meta.entity}` : chunk.title || "Portfolio Knowledge PDF";
        const pageLabel = meta.page ? ` (Page ${meta.page})` : "";
        
        contextTexts.push(`--- SECTION: ${sourceLabel}${pageLabel} ---\n${chunk.content}`);
        
        const citationKey = `${meta.source || "prince-portfolio-knowledge.pdf"}-page-${meta.page || 1}`;
        if (!sourcesMap.has(citationKey)) {
          sourcesMap.set(citationKey, {
            title: meta.entity || meta.section || "Portfolio Knowledge",
            source: meta.source || "prince-portfolio-knowledge.pdf",
            page: meta.page || 1,
            section: meta.section || "General"
          });
        }
      });
    }

    const retrievedContextStr = contextTexts.length > 0
      ? contextTexts.join("\n\n")
      : "No specific chunks were retrieved from Prince's portfolio knowledge PDF for this query.";

    // STEP 4: Grounded System Prompt Construction
    const systemPrompt = `You are the AI portfolio assistant representing Prince Singh.
Answer visitor questions about Prince's background, education, academic timeline, technical skills, projects, project architecture, hackathons, achievements, certifications, and career interests.

STRICT RAG GROUNDING RULES:
1. Ground your answers strictly on the retrieved portfolio knowledge context below.
2. Use conversation history to resolve pronouns and implicit references (e.g. "it", "this project", "the second one", "his CGPA", "that hackathon").
3. NEVER invent or fabricate facts, CGPA, percentage marks, dates, companies, internships, project results, certifications, or awards not present in the retrieved context.
4. If the requested information is NOT explicitly documented in the retrieved portfolio knowledge PDF, state clearly: "I don't have that specific information in Prince's portfolio knowledge base."
5. Be professional, friendly, concise, and helpful.

RETRIEVED PORTFOLIO KNOWLEDGE CONTEXT:
${retrievedContextStr}`;

    // STEP 5: Call Gemini LLM (Primary) with Automatic Fallback to Mistral LLM
    console.log(`[CHAT] Step 5: Generating response (Primary: Gemini ${GEMINI_LLM_MODEL})...`);
    let finalAnswerText = null;
    let usedProvider = "Gemini";

    // Helper: Call Gemini LLM
    async function callGeminiLLM() {
      const promptMessages = [];
      promptMessages.push({ role: "user", parts: [{ text: systemPrompt }] });
      promptMessages.push({ role: "model", parts: [{ text: "Understood. I will answer visitor questions accurately based strictly on the retrieved portfolio knowledge PDF." }] });

      recentHistory.forEach((turn) => {
        promptMessages.push({
          role: turn.role === "user" ? "user" : "model",
          parts: [{ text: turn.content }]
        });
      });

      promptMessages.push({ role: "user", parts: [{ text: userQuery }] });

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LLM_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: promptMessages,
            generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
          })
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        let errCode = res.status;
        try {
          const parsed = JSON.parse(errText);
          errCode = parsed?.error?.code || res.status;
        } catch (e) {}
        const error = new Error(`Gemini LLM returned HTTP ${res.status}: ${errText}`);
        error.status = res.status;
        error.code = errCode;
        throw error;
      }

      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    // Helper: Call Mistral LLM (Fallback)
    async function callMistralLLM() {
      if (!MISTRAL_API_KEY) {
        throw new Error("MISTRAL_API_KEY is not configured for fallback.");
      }

      console.log(`[CHAT] Calling fallback provider Mistral LLM (${MISTRAL_LLM_MODEL})...`);
      const messages = [{ role: "system", content: systemPrompt }];

      recentHistory.forEach((turn) => {
        messages.push({
          role: turn.role === "user" ? "user" : "assistant",
          content: turn.content
        });
      });

      messages.push({ role: "user", content: userQuery });

      const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model: MISTRAL_LLM_MODEL,
          messages: messages,
          temperature: 0.3,
          max_tokens: 600
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        const error = new Error(`Mistral LLM returned HTTP ${res.status}: ${errText}`);
        error.status = res.status;
        throw error;
      }

      const data = await res.json();
      return data?.choices?.[0]?.message?.content;
    }

    // Execute Primary (Gemini) -> Fallback (Mistral)
    try {
      finalAnswerText = await callGeminiLLM();
      console.log("[CHAT] Gemini LLM generation succeeded.");
    } catch (geminiError) {
      const isQuotaOrTransient = geminiError.status === 429 || geminiError.status === 503 || geminiError.status === 404 || geminiError.status >= 500;
      
      console.warn(`[CHAT WARN] Gemini LLM failed (HTTP ${geminiError.status}). Transient/Quota eligible: ${isQuotaOrTransient}`);
      
      if (isQuotaOrTransient && MISTRAL_API_KEY) {
        try {
          console.log("[CHAT] Falling back to Mistral LLM...");
          finalAnswerText = await callMistralLLM();
          usedProvider = "Mistral";
          console.log("[CHAT] Mistral LLM generation succeeded.");
        } catch (mistralError) {
          console.error("[CHAT ERROR] Mistral LLM fallback failed:", mistralError.message);
          throw geminiError; // throw original if fallback fails
        }
      } else {
        throw geminiError;
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "I'm sorry, I was unable to process a response from the AI services.";
    }

    const sources = Array.from(sourcesMap.values());

    console.log(`[CHAT] Request completed successfully using ${usedProvider}. Returning HTTP 200.`);

    return res.status(200).json({
      answer: finalAnswerText,
      sources: sources
    });

  } catch (error) {
    console.error("[CHAT ERROR] Exception processing /api/chat request:", error.message);
    
    if (error.status === 429) {
      return res.status(429).json({
        error: "AI service rate limit or quota exceeded. Please try again in a few seconds."
      });
    }

    return res.status(500).json({
      error: "An internal server error occurred while processing your request.",
      details: error.message
    });
  }
}
