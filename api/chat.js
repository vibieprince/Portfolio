// api/chat.js - Production Portfolio Chatbot Endpoint with Request ID & Safe Diagnostics

import { crypto } from "crypto";

// Helper: Generate unique short Request ID (e.g. req-a1b2c3d4)
function generateRequestId() {
  return "req-" + Math.random().toString(36).substring(2, 10);
}

// Helper: Validate Server Configuration safely without logging keys
function validateConfiguration() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

  const config = {
    hasGeminiKey: !!GEMINI_API_KEY,
    hasSupabaseUrl: !!SUPABASE_URL,
    hasSupabaseKey: !!SUPABASE_SERVICE_KEY,
    hasMistralKey: !!MISTRAL_API_KEY,
    isReady: !!(GEMINI_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_KEY)
  };

  return config;
}

export default async function handler(req, res) {
  const reqId = generateRequestId();
  const startTime = Date.now();

  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "METHOD_NOT_ALLOWED",
      answer: "Method not allowed. Use POST.",
      requestId: reqId
    });
  }

  console.log(`[CHAT ${reqId}] Request received at /api/chat`);

  // Environment Variables & Aliases
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

  const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || "gemini-embedding-2";
  const EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || "768", 10);
  
  const PRIMARY_GEMINI_MODEL = process.env.GEMINI_LLM_MODEL || process.env.LLM_MODEL || "gemini-3.5-flash-lite";
  const FALLBACK_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.8-flash"];
  const MISTRAL_LLM_MODEL = process.env.MISTRAL_LLM_MODEL || "mistral-small-latest";
  const CHAT_DEBUG = process.env.CHAT_DEBUG === "true";

  // Configuration Audit Logging
  const configState = validateConfiguration();
  console.log(`[CHAT ${reqId}] Config Audit:`, {
    GEMINI_API_KEY: configState.hasGeminiKey ? "configured" : "MISSING",
    GEMINI_LLM_MODEL: PRIMARY_GEMINI_MODEL,
    EMBEDDING_MODEL: EMBEDDING_MODEL,
    SUPABASE_URL: configState.hasSupabaseUrl ? "configured" : "MISSING",
    SUPABASE_SERVICE_KEY: configState.hasSupabaseKey ? "configured" : "MISSING",
    MISTRAL_API_KEY: configState.hasMistralKey ? "configured" : "not-configured",
    MISTRAL_LLM_MODEL: MISTRAL_LLM_MODEL
  });

  // Strict Pre-flight Configuration Failure Check
  if (!configState.isReady) {
    console.error(`[CHAT ${reqId} CONFIG ERROR] Server missing required environment variables. Required: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.`);
    return res.status(500).json({
      error: "SERVER_CONFIGURATION_ERROR",
      answer: "Server configuration missing required environment variables.",
      requestId: reqId
    });
  }

  try {
    const { message, conversation = [], pageContext = {} } = req.body || {};

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      console.warn(`[CHAT ${reqId}] Invalid user message provided.`);
      return res.status(400).json({
        error: "INVALID_REQUEST",
        answer: "Message parameter is required.",
        requestId: reqId
      });
    }

    const userQuery = message.trim().slice(0, 1000);
    const recentHistory = Array.isArray(conversation) ? conversation.slice(-8) : [];
    console.log(`[CHAT ${reqId}] Input payload validated. Query length: ${userQuery.length} chars, History turns: ${recentHistory.length}`);

    // STEP 1: Standalone Search Query Reformulation
    let retrievalQuery = userQuery;

    if (recentHistory.length > 0) {
      console.log(`[CHAT ${reqId}] Step 1: Reformulating context-aware standalone search query...`);
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
          `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
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
            console.log(`[CHAT ${reqId}] Query reformulated successfully (length: ${retrievalQuery.length} chars)`);
          }
        }
      } catch (err) {
        console.warn(`[CHAT ${reqId} WARN] Query reform fetch failed, using raw query:`, err.message);
      }
    }

    // STEP 2: Generate Vector Query Embedding (Gemini)
    console.log(`[CHAT ${reqId}] Step 2: Generating query embedding via ${EMBEDDING_MODEL}...`);
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
        console.error(`[CHAT ${reqId} ERROR] Gemini Embedding API returned HTTP ${embedRes.status}`);
        throw new Error(`Gemini Embedding API returned ${embedRes.status}: ${errText.slice(0, 150)}`);
      }

      const embedData = await embedRes.json();
      queryVector = embedData?.embedding?.values;
      console.log(`[CHAT ${reqId}] Embedding generated successfully (${queryVector ? queryVector.length : 0} dims).`);
    } catch (embedError) {
      console.error(`[CHAT ${reqId} ERROR] Gemini Embedding service failed:`, embedError.message);
      return res.status(502).json({
        error: "EMBEDDING_SERVICE_ERROR",
        answer: "Failed to communicate with Gemini Embedding service.",
        requestId: reqId
      });
    }

    // STEP 3: Search Supabase pgvector Vector Database
    console.log(`[CHAT ${reqId}] Step 3: Querying Supabase pgvector RPC match_documents...`);
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
        console.error(`[CHAT ${reqId} ERROR] Supabase RPC returned HTTP ${rpcRes.status}`);
        throw new Error(`Supabase RPC returned ${rpcRes.status}: ${rpcErr.slice(0, 150)}`);
      }

      retrievedChunks = await rpcRes.json();
      console.log(`[CHAT ${reqId}] Supabase search completed. Retrieved ${retrievedChunks.length} chunks.`);
    } catch (rpcError) {
      console.error(`[CHAT ${reqId} ERROR] Supabase RPC fetch failed:`, rpcError.message);
      return res.status(502).json({
        error: "VECTOR_DATABASE_ERROR",
        answer: "Failed to connect to Supabase vector database.",
        requestId: reqId
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

    // STEP 5: Multi-tier LLM Response Generation (Gemini Primary -> Alternative Gemini Models -> Mistral)
    console.log(`[CHAT ${reqId}] Step 5: Generating response (Primary model: ${PRIMARY_GEMINI_MODEL})...`);
    let finalAnswerText = null;
    let usedProvider = "Gemini (" + PRIMARY_GEMINI_MODEL + ")";

    // Helper: Call specific Gemini LLM model with safe diagnostic logging & defensive payload parsing
    async function callGeminiModel(modelName) {
      console.log(`[CHAT ${reqId}] Attempting Gemini model: ${modelName}`);
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
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: promptMessages,
            generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
          })
        }
      );

      console.log(`[CHAT ${reqId}] Gemini (${modelName}) HTTP status: ${res.status}`);

      if (!res.ok) {
        const errText = await res.text();
        let errCode = res.status;
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          errCode = parsed?.error?.code || res.status;
          errMsg = parsed?.error?.message || errText;
        } catch (e) {}

        console.warn(`[CHAT ${reqId} WARN] Gemini model ${modelName} returned HTTP ${res.status}:`, {
          code: errCode,
          message: errMsg ? errMsg.slice(0, 150) : ""
        });

        const error = new Error(`Gemini LLM (${modelName}) returned HTTP ${res.status}`);
        error.status = res.status;
        error.code = errCode;
        throw error;
      }

      const data = await res.json();
      
      // Safe Diagnostic Metadata Logging
      const candidates = data?.candidates || [];
      const firstCandidate = candidates[0] || {};
      const finishReason = firstCandidate.finishReason || "UNKNOWN";
      const parts = firstCandidate.content?.parts || [];
      const text = parts[0]?.text || "";

      console.log(`[CHAT ${reqId}] Gemini (${modelName}) response metadata:`, {
        candidatesCount: candidates.length,
        finishReason: finishReason,
        partsCount: parts.length,
        textLength: text.length
      });

      // Defensive Parsing Check
      if (!candidates.length || !parts.length || !text.trim()) {
        console.warn(`[CHAT ${reqId} WARN] Gemini model ${modelName} returned 200 OK but candidate/text content was empty or blocked (finishReason: ${finishReason}).`);
        const error = new Error(`Gemini LLM (${modelName}) returned empty text content (finishReason: ${finishReason})`);
        error.status = 502;
        throw error;
      }

      return text.trim();
    }

    // Helper: Call Mistral LLM
    async function callMistralLLM() {
      if (!MISTRAL_API_KEY) {
        console.warn(`[CHAT ${reqId} WARN] Mistral fallback requested but MISTRAL_API_KEY is not configured.`);
        throw new Error("MISTRAL_API_KEY is not configured.");
      }

      console.log(`[CHAT ${reqId}] Calling fallback provider Mistral LLM (${MISTRAL_LLM_MODEL})...`);
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

      console.log(`[CHAT ${reqId}] Mistral HTTP status: ${res.status}`);

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[CHAT ${reqId} WARN] Mistral LLM returned HTTP ${res.status}`);
        const error = new Error(`Mistral LLM returned HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      
      if (!content || !content.trim()) {
        const error = new Error("Mistral returned empty content.");
        error.status = 502;
        throw error;
      }

      return content.trim();
    }

    // Execute Multi-tier LLM Pipeline
    // Tier 1: Primary Gemini Model
    try {
      finalAnswerText = await callGeminiModel(PRIMARY_GEMINI_MODEL);
    } catch (primaryErr) {
      console.warn(`[CHAT ${reqId} WARN] Primary Gemini model (${PRIMARY_GEMINI_MODEL}) failed:`, primaryErr.message);

      // Tier 2: Alternative Gemini Models
      const alternativeGeminiModels = FALLBACK_GEMINI_MODELS.filter(m => m !== PRIMARY_GEMINI_MODEL);
      for (const fallbackModel of alternativeGeminiModels) {
        try {
          console.log(`[CHAT ${reqId}] MODEL FALLBACK: ${PRIMARY_GEMINI_MODEL} → ${fallbackModel}`);
          finalAnswerText = await callGeminiModel(fallbackModel);
          usedProvider = "Gemini (" + fallbackModel + ")";
          break;
        } catch (fbErr) {
          console.warn(`[CHAT ${reqId} WARN] Secondary Gemini model (${fallbackModel}) failed:`, fbErr.message);
        }
      }

      // Tier 3: Mistral LLM (if all Gemini tiers failed)
      if (!finalAnswerText && configState.hasMistralKey) {
        try {
          console.log(`[CHAT ${reqId}] PROVIDER FALLBACK: Gemini → Mistral (${MISTRAL_LLM_MODEL})`);
          finalAnswerText = await callMistralLLM();
          usedProvider = "Mistral (" + MISTRAL_LLM_MODEL + ")";
        } catch (mistralErr) {
          console.error(`[CHAT ${reqId} ERROR] Mistral fallback failed:`, mistralErr.message);
        }
      }
    }

    const sources = Array.from(sourcesMap.values());
    const duration = Date.now() - startTime;

    if (finalAnswerText) {
      console.log(`[CHAT ${reqId}] Request completed successfully using ${usedProvider} in ${duration}ms. Returning HTTP 200.`);
      return res.status(200).json({
        answer: finalAnswerText,
        sources: sources,
        requestId: reqId
      });
    } else {
      console.error(`[CHAT ${reqId} ERROR] All AI providers (Primary Gemini, Alternative Gemini models, Mistral) failed to generate a response in ${duration}ms.`);
      return res.status(503).json({
        error: "AI_SERVICE_TEMPORARILY_UNAVAILABLE",
        answer: "I'm having trouble reaching my AI services right now. Please try again in a few seconds.",
        requestId: reqId
      });
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[CHAT ${reqId} ERROR] Unhandled exception processing request (${duration}ms):`, error.message);
    
    return res.status(503).json({
      error: "AI_SERVICE_TEMPORARILY_UNAVAILABLE",
      answer: "I'm having trouble reaching my AI services right now. Please try again in a few seconds.",
      requestId: reqId
    });
  }
}
