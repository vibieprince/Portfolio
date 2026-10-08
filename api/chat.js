// api/chat.js - Production Portfolio Chatbot Endpoint with Robust SSE Token Streaming & Recruiter Grounding

function generateRequestId() {
  return "req-" + Math.random().toString(36).substring(2, 10);
}

function validateConfiguration() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

  return {
    hasGeminiKey: !!GEMINI_API_KEY,
    hasSupabaseUrl: !!SUPABASE_URL,
    hasSupabaseKey: !!SUPABASE_SERVICE_KEY,
    hasMistralKey: !!MISTRAL_API_KEY,
    isReady: !!(GEMINI_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_KEY)
  };
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
  const MISTRAL_LLM_MODEL = process.env.MISTRAL_LLM_MODEL || "mistral-small-latest";

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

  if (!configState.isReady) {
    console.error(`[CHAT ${reqId} CONFIG ERROR] Missing required env vars.`);
    return res.status(500).json({
      error: "SERVER_CONFIGURATION_ERROR",
      answer: "Server configuration missing required environment variables.",
      requestId: reqId
    });
  }

  try {
    const { message, conversation = [], stream = false } = req.body || {};

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        answer: "Message parameter is required.",
        requestId: reqId
      });
    }

    const userQuery = message.trim().slice(0, 1000);
    const recentHistory = Array.isArray(conversation) ? conversation.slice(-8) : [];
    const isStreamRequested = stream === true || req.headers.accept?.includes("text/event-stream");

    console.log(`[CHAT ${reqId}] Query length: ${userQuery.length} chars, History turns: ${recentHistory.length}, Stream requested: ${isStreamRequested}`);

    // STEP 1: Query Reformulation
    let retrievalQuery = userQuery;
    if (recentHistory.length > 0) {
      console.log(`[CHAT ${reqId}] Step 1: Reformulating search query...`);
      const historyText = recentHistory.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
      const queryReformPrompt = `Given the conversation history and follow-up message, rephrase into a concise standalone search query preserving implicit context, pronouns (it, second one, score), and entities.\n\nHISTORY:\n${historyText}\n\nFOLLOW-UP:\n${userQuery}\n\nSTANDALONE QUERY:`;

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
            console.log(`[CHAT ${reqId}] Reformulated to: "${retrievalQuery}"`);
          }
        }
      } catch (err) {
        console.warn(`[CHAT ${reqId} WARN] Query reform failed:`, err.message);
      }
    }

    // STEP 2: Vector Query Embedding
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
        throw new Error(`Embedding API returned ${embedRes.status}: ${errText.slice(0, 150)}`);
      }

      const embedData = await embedRes.json();
      queryVector = embedData?.embedding?.values;
      console.log(`[CHAT ${reqId}] Embedding generated (${queryVector ? queryVector.length : 0} dims).`);
    } catch (embedError) {
      console.error(`[CHAT ${reqId} ERROR] Embedding failed:`, embedError.message);
      return res.status(502).json({
        error: "EMBEDDING_SERVICE_ERROR",
        answer: "Failed to communicate with Gemini Embedding service.",
        requestId: reqId
      });
    }

    // STEP 3: Vector Search in Supabase
    console.log(`[CHAT ${reqId}] Step 3: Querying Supabase pgvector RPC...`);
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
        throw new Error(`Supabase RPC returned ${rpcRes.status}: ${rpcErr.slice(0, 150)}`);
      }

      retrievedChunks = await rpcRes.json();
      console.log(`[CHAT ${reqId}] Supabase search returned ${retrievedChunks.length} chunks.`);
    } catch (rpcError) {
      console.error(`[CHAT ${reqId} ERROR] Vector DB query failed:`, rpcError.message);
      return res.status(502).json({
        error: "VECTOR_DATABASE_ERROR",
        answer: "Failed to connect to Supabase vector database.",
        requestId: reqId
      });
    }

    // Format Context and Sources
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

    const sources = Array.from(sourcesMap.values());

    // STEP 4: Grounded Recruiter-Focused System Prompt
    const systemPrompt = `You are Prince Singh's Recruiter-Focused AI Portfolio Assistant.
Your primary mission is to help recruiters, technical hiring managers, and interviewers evaluate Prince Singh's suitability for engineering roles (Software/Backend, Data Science, Data Engineering, Cloud/DevOps, AI/GenAI).

KNOWLEDGE BOUNDARY & RULES:
1. GREETINGS & SMALL TALK: If the user greets you (e.g. "hi", "hello", "good morning", "hey", "who are you?"), respond warmly, introduce yourself as Prince's AI Portfolio Assistant, and offer assistance regarding his education, skills, projects, achievements, and technical profile.
2. FACTUAL ANSWERS: For explicit facts about Prince (education, CGPA, technologies, project features, hackathon results, certifications, dates), answer strictly based on the retrieved portfolio knowledge PDF context. NEVER fabricate CGPA, marks, companies, internships, project results, certifications, or awards.
3. RECRUITER INFERENCES: If asked for recruiter-focused evaluation, technical analysis, interview question suggestions, or potential project challenges (e.g. "Why consider Prince?", "What challenges did he face in RentEase?", "What interviewer questions could be asked?"), answer thoughtfully using his portfolio projects and skills as evidence, but CLEARLY label your analysis as an inference/evaluation based on documented evidence (e.g., "Based on documented project evidence...").
4. GENERAL TASKS REDIRECTION: If asked to perform unrelated general-purpose tasks (e.g., "Write a Python script to reverse a string", "Explain quantum physics", "Who won the World Cup?"), politely refuse and redirect: "I am Prince's portfolio assistant, focused on answering questions about Prince's education, skills, projects, achievements, and technical background rather than general tasks."
5. If factual information is missing from the retrieved context, state: "I don't have that specific information in Prince's portfolio knowledge base."
6. Be professional, clear, concise, and structured.

RETRIEVED PORTFOLIO KNOWLEDGE CONTEXT:
${retrievedContextStr}`;

    // STEP 5: Model Selection & Stream / Non-Stream Handling
    console.log(`[CHAT ${reqId}] Step 5: Preparing LLM stream/response...`);

    // Helper: Stream response using SSE
    if (isStreamRequested) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const sendSSEEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendSSEEvent("start", { requestId: reqId });

      let streamSuccess = false;
      let activeProvider = "Gemini (" + PRIMARY_GEMINI_MODEL + ")";

      // Helper: Attempt Gemini Stream
      const attemptGeminiStream = async (modelName) => {
        const promptMessages = [];
        promptMessages.push({ role: "user", parts: [{ text: systemPrompt }] });
        promptMessages.push({ role: "model", parts: [{ text: "Understood. I will represent Prince Singh accurately to recruiters and interviewers using the retrieved portfolio knowledge context." }] });
        recentHistory.forEach((turn) => {
          promptMessages.push({
            role: turn.role === "user" ? "user" : "model",
            parts: [{ text: turn.content }]
          });
        });
        promptMessages.push({ role: "user", parts: [{ text: userQuery }] });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        console.log(`[CHAT ${reqId}] Sending stream request to Gemini (${modelName})...`);

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: promptMessages,
              generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
            }),
            signal: controller.signal
          }
        );
        clearTimeout(timeoutId);

        console.log(`[CHAT ${reqId}] Gemini (${modelName}) HTTP status: ${geminiRes.status}`);

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          console.warn(`[CHAT ${reqId} WARN] Gemini stream HTTP ${geminiRes.status}: ${errText.slice(0, 150)}`);
          const err = new Error(`Gemini stream HTTP ${geminiRes.status}`);
          err.status = geminiRes.status;
          throw err;
        }

        // Read SSE stream from Gemini using Web Streams API + TextDecoder
        const reader = geminiRes.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let hasStreamedToken = false;
        let firstTokenLogged = false;

        console.log(`[CHAT ${reqId}] Gemini SSE parser initialized`);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const rawLine = typeof line === "string" ? line : String(line);
            const trimmedLine = rawLine.trim();

            if (trimmedLine.startsWith("data: ")) {
              const jsonStr = trimmedLine.substring(6).trim();
              if (jsonStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const textChunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textChunk) {
                  if (!firstTokenLogged) {
                    console.log(`[CHAT ${reqId}] Gemini first token received`);
                    firstTokenLogged = true;
                  }
                  hasStreamedToken = true;
                  sendSSEEvent("token", { text: textChunk });
                }
              } catch (e) {}
            }
          }
        }

        // Flush remaining buffer
        buffer += decoder.decode();
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            const rawLine = typeof line === "string" ? line : String(line);
            const trimmedLine = rawLine.trim();
            if (trimmedLine.startsWith("data: ")) {
              const jsonStr = trimmedLine.substring(6).trim();
              if (jsonStr !== "[DONE]") {
                try {
                  const parsed = JSON.parse(jsonStr);
                  const textChunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (textChunk) {
                    if (!firstTokenLogged) {
                      console.log(`[CHAT ${reqId}] Gemini first token received`);
                      firstTokenLogged = true;
                    }
                    hasStreamedToken = true;
                    sendSSEEvent("token", { text: textChunk });
                  }
                } catch (e) {}
              }
            }
          }
        }

        if (!hasStreamedToken) {
          throw new Error("Gemini stream returned no text tokens");
        }

        return true;
      };

      // Helper: Attempt Mistral Stream
      const attemptMistralStream = async () => {
        if (!MISTRAL_API_KEY) throw new Error("Mistral API key missing");

        const messages = [{ role: "system", content: systemPrompt }];
        recentHistory.forEach((turn) => {
          messages.push({
            role: turn.role === "user" ? "user" : "assistant",
            content: turn.content
          });
        });
        messages.push({ role: "user", content: userQuery });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        console.log(`[CHAT ${reqId}] Sending stream request to Mistral (${MISTRAL_LLM_MODEL})...`);

        const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${MISTRAL_API_KEY}`
          },
          body: JSON.stringify({
            model: MISTRAL_LLM_MODEL,
            messages: messages,
            temperature: 0.3,
            max_tokens: 600,
            stream: true
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        console.log(`[CHAT ${reqId}] Mistral HTTP status: ${mistralRes.status}`);

        if (!mistralRes.ok) {
          const errText = await mistralRes.text();
          console.warn(`[CHAT ${reqId} WARN] Mistral stream HTTP ${mistralRes.status}: ${errText.slice(0, 150)}`);
          const err = new Error(`Mistral stream HTTP ${mistralRes.status}`);
          err.status = mistralRes.status;
          throw err;
        }

        const reader = mistralRes.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let hasStreamedToken = false;
        let firstTokenLogged = false;

        console.log(`[CHAT ${reqId}] Mistral SSE parser initialized`);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const rawLine = typeof line === "string" ? line : String(line);
            const trimmedLine = rawLine.trim();

            if (trimmedLine.startsWith("data: ")) {
              const jsonStr = trimmedLine.substring(6).trim();
              if (jsonStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const textChunk = parsed?.choices?.[0]?.delta?.content;
                if (textChunk) {
                  if (!firstTokenLogged) {
                    console.log(`[CHAT ${reqId}] Mistral first token received`);
                    firstTokenLogged = true;
                  }
                  hasStreamedToken = true;
                  sendSSEEvent("token", { text: textChunk });
                }
              } catch (e) {}
            }
          }
        }

        if (!hasStreamedToken) throw new Error("Mistral stream returned no text tokens");
        return true;
      };

      // Try Primary Gemini Model
      try {
        console.log(`[CHAT ${reqId}] Starting SSE stream with primary Gemini model (${PRIMARY_GEMINI_MODEL})...`);
        await attemptGeminiStream(PRIMARY_GEMINI_MODEL);
        streamSuccess = true;
      } catch (geminiErr) {
        console.warn(`[CHAT ${reqId} WARN] Primary Gemini stream failed before token delivery:`, geminiErr.message);

        // Provider Fallback to Mistral (Before Stream Begins)
        if (configState.hasMistralKey) {
          try {
            console.log(`[CHAT ${reqId}] PROVIDER STREAM FALLBACK: Gemini → Mistral (${MISTRAL_LLM_MODEL})`);
            await attemptMistralStream();
            streamSuccess = true;
            activeProvider = "Mistral (" + MISTRAL_LLM_MODEL + ")";
          } catch (mErr) {
            console.error(`[CHAT ${reqId} ERROR] Mistral stream fallback failed (HTTP ${mErr.status || 500}):`, mErr.message);
          }
        }
      }

      if (streamSuccess) {
        console.log(`[CHAT ${reqId}] Stream completed successfully using ${activeProvider}. Sending done event.`);
        sendSSEEvent("done", {
          provider: activeProvider,
          sources: sources,
          requestId: reqId
        });
        return res.end();
      } else {
        console.error(`[CHAT ${reqId} ERROR] All streaming providers failed.`);
        sendSSEEvent("error", {
          error: "AI_SERVICE_TEMPORARILY_UNAVAILABLE",
          answer: "I'm having trouble reaching my AI services right now. Please try again in a few seconds.",
          requestId: reqId
        });
        return res.end();
      }

    } else {
      // Non-Streaming Path
      console.log(`[CHAT ${reqId}] Non-streaming request processing...`);
      let finalAnswerText = null;
      let usedProvider = "Gemini (" + PRIMARY_GEMINI_MODEL + ")";

      async function callGeminiModel(modelName) {
        const promptMessages = [];
        promptMessages.push({ role: "user", parts: [{ text: systemPrompt }] });
        promptMessages.push({ role: "model", parts: [{ text: "Understood. I will represent Prince Singh accurately using the retrieved context." }] });
        recentHistory.forEach((turn) => {
          promptMessages.push({
            role: turn.role === "user" ? "user" : "model",
            parts: [{ text: turn.content }]
          });
        });
        promptMessages.push({ role: "user", parts: [{ text: userQuery }] });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: promptMessages,
                generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
              }),
              signal: controller.signal
            }
          );
          clearTimeout(timeoutId);

          if (!res.ok) throw new Error(`Gemini (${modelName}) HTTP ${res.status}`);

          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text || !text.trim()) throw new Error(`Gemini (${modelName}) returned empty text`);
          return text.trim();
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
      }

      try {
        finalAnswerText = await callGeminiModel(PRIMARY_GEMINI_MODEL);
      } catch (err) {
        if (configState.hasMistralKey) {
          try {
            console.log(`[CHAT ${reqId}] Non-stream fallback to Mistral...`);
            const messages = [{ role: "system", content: systemPrompt }];
            recentHistory.forEach((turn) => {
              messages.push({ role: turn.role === "user" ? "user" : "assistant", content: turn.content });
            });
            messages.push({ role: "user", content: userQuery });
            const mRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${MISTRAL_API_KEY}` },
              body: JSON.stringify({ model: MISTRAL_LLM_MODEL, messages: messages, temperature: 0.3, max_tokens: 600 })
            });
            if (mRes.ok) {
              const mData = await mRes.json();
              finalAnswerText = mData?.choices?.[0]?.message?.content;
              usedProvider = "Mistral (" + MISTRAL_LLM_MODEL + ")";
            }
          } catch (mErr) {}
        }
      }

      if (finalAnswerText) {
        return res.status(200).json({
          answer: finalAnswerText,
          sources: sources,
          requestId: reqId
        });
      } else {
        return res.status(503).json({
          error: "AI_SERVICE_TEMPORARILY_UNAVAILABLE",
          answer: "I'm having trouble reaching my AI services right now. Please try again.",
          requestId: reqId
        });
      }
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[CHAT ${reqId} ERROR] Exception processing request (${duration}ms):`, error.message);
    if (!res.headersSent) {
      return res.status(503).json({
        error: "AI_SERVICE_TEMPORARILY_UNAVAILABLE",
        answer: "I'm having trouble reaching my AI services right now. Please try again.",
        requestId: reqId
      });
    }
  }
}
