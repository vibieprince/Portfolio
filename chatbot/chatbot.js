/**
 * Prince Portfolio AI Assistant — chatbot.js
 * PDF-grounded RAG chatbot with session memory.
 * Talks to /api/chat (server-side Gemini → Mistral fallback).
 * State stored in sessionStorage only — no persistent visitor tracking.
 */

(function () {
  'use strict';

  /* ============================================================
     CONFIGURATION
  ============================================================ */
  const CONFIG = {
    API_ENDPOINT: '/api/chat',
    MAX_HISTORY: 10,         // max messages sent to API
    WELCOME_MESSAGE: "Hi! I'm Prince's AI Assistant 👋\nAsk me about his education, skills, projects, hackathons, achievements, certifications, or experience. Everything I know comes directly from his portfolio knowledge base.",
    SUGGESTIONS: [
      'Tell me about Prince',
      'Education & CGPA',
      'Projects',
      'Skills & Tech Stack',
      'Achievements',
      'Certifications',
    ],
    STORAGE_KEY: 'prince_chat_history',
  };

  /* ============================================================
     STATE
  ============================================================ */
  let isOpen = false;
  let isLoading = false;
  let conversationHistory = [];  // [{role:'user'|'assistant', content:'...'}]
  let lastFailedMessage = null;
  let suggestionsHidden = false;

  /* ============================================================
     HTML TEMPLATE
  ============================================================ */
  function buildChatbotHTML() {
    return `
<!-- Chatbot Live Region for Screen Readers -->
<div id="chat-live-region" aria-live="polite" aria-atomic="true" role="status"></div>

<!-- Launcher Button -->
<button
  id="chat-launcher"
  aria-label="Open Prince's AI Assistant"
  aria-expanded="false"
  aria-controls="chat-panel"
>
  <span class="chat-launcher-dot" aria-hidden="true"></span>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>
  <span>Ask AI</span>
</button>

<!-- Chat Panel -->
<div
  id="chat-panel"
  role="dialog"
  aria-label="Prince's AI Portfolio Assistant"
  aria-modal="true"
>
  <!-- Header -->
  <header id="chat-header">
    <div id="chat-header-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"></path>
        <path d="M20 21a8 8 0 1 0-16 0"></path>
      </svg>
    </div>
    <div id="chat-header-info">
      <div id="chat-header-title">Prince's AI Assistant</div>
      <div id="chat-header-subtitle">PDF Knowledge Base · Always Available</div>
    </div>
    <div class="chat-header-actions">
      <button class="chat-icon-btn" id="chat-clear-btn" aria-label="Clear conversation" title="Clear conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path><path d="M14 11v6"></path>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
        </svg>
      </button>
      <button class="chat-icon-btn" id="chat-close-btn" aria-label="Close AI assistant" title="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  </header>

  <!-- Messages -->
  <div id="chat-messages" role="log" aria-label="Chat messages" aria-live="polite">
    <!-- populated by JS -->
  </div>

  <!-- Typing indicator -->
  <div id="chat-typing" aria-hidden="true" aria-label="Assistant is typing">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>

  <!-- Suggestion chips (shown before first message) -->
  <div id="chat-suggestions" aria-label="Suggested questions" role="group">
    ${CONFIG.SUGGESTIONS.map(s => `<button class="chat-chip" tabindex="0">${s}</button>`).join('\n    ')}
  </div>

  <!-- Input area -->
  <div id="chat-input-area">
    <textarea
      id="chat-input"
      placeholder="Ask about Prince's portfolio…"
      rows="1"
      maxlength="1000"
      aria-label="Type your question"
      aria-multiline="true"
      autocomplete="off"
      autocorrect="off"
      spellcheck="true"
    ></textarea>
    <button id="chat-send-btn" aria-label="Send message" disabled>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
    </button>
  </div>
</div>
`;
  }

  /* ============================================================
     DOM HELPERS
  ============================================================ */
  const $ = (id) => document.getElementById(id);

  function formatTime() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Convert plain text with newlines to HTML, preserving links */
  function formatMessageText(text) {
    // Escape HTML first
    let safe = escapeHTML(text);
    // Convert **bold** markdown
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Convert *italic* markdown
    safe = safe.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Convert URLs to clickable links
    safe = safe.replace(
      /(https?:\/\/[^\s<>"]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    // Convert numbered/bulleted list items
    safe = safe.replace(/^(\d+\.\s)/gm, '<span style="font-weight:600">$1</span>');
    safe = safe.replace(/^([•\-\*]\s)/gm, '<span aria-hidden="true">• </span>');
    // Newlines to <br>
    safe = safe.replace(/\n/g, '<br>');
    return safe;
  }

  function scrollToBottom(animate = true) {
    const msgs = $('chat-messages');
    if (!msgs) return;
    if (animate) {
      msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
    } else {
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  function announceToScreenReader(text) {
    const region = $('chat-live-region');
    if (region) {
      region.textContent = '';
      // Force re-announcement via timeout trick
      setTimeout(() => { region.textContent = text; }, 50);
    }
  }

  /* ============================================================
     SESSION STORAGE
  ============================================================ */
  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(CONFIG.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveHistory(history) {
    try {
      sessionStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(history));
    } catch (e) { /* ignore quota errors silently */ }
  }

  function clearHistory() {
    conversationHistory = [];
    try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {}
  }

  /* ============================================================
     MESSAGE RENDERING
  ============================================================ */
  function renderWelcome() {
    const msgs = $('chat-messages');
    if (!msgs) return;
    msgs.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-bot';
    div.setAttribute('role', 'article');
    div.setAttribute('aria-label', 'Assistant message');
    div.innerHTML = `
      <div class="chat-bubble chat-bubble-bot">${formatMessageText(CONFIG.WELCOME_MESSAGE)}</div>
      <div class="chat-msg-time" aria-label="Sent at ${formatTime()}">${formatTime()}</div>
    `;
    msgs.appendChild(div);
  }

  function appendUserMessage(text) {
    const msgs = $('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-user';
    div.setAttribute('role', 'article');
    div.setAttribute('aria-label', 'Your message');
    div.innerHTML = `
      <div class="chat-bubble chat-bubble-user">${formatMessageText(text)}</div>
      <div class="chat-msg-time" aria-label="Sent at ${formatTime()}">${formatTime()}</div>
    `;
    msgs.appendChild(div);
    scrollToBottom();
    return div;
  }

  function appendBotMessage(text, sources) {
    const msgs = $('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-bot';
    div.setAttribute('role', 'article');
    div.setAttribute('aria-label', 'Assistant response');

    let sourcesHTML = '';
    if (sources && sources.length > 0) {
      const tags = sources.slice(0, 3).map(s =>
        `<span class="chat-source-tag">📄 ${escapeHTML(s.section || s.title || 'PDF')} · p.${s.page || '?'}</span>`
      ).join('');
      sourcesHTML = `<div class="chat-sources">${tags}</div>`;
    }

    div.innerHTML = `
      <div class="chat-bubble chat-bubble-bot">${formatMessageText(text)}</div>
      ${sourcesHTML}
      <div class="chat-msg-time" aria-label="Received at ${formatTime()}">${formatTime()}</div>
    `;
    msgs.appendChild(div);
    scrollToBottom();
    announceToScreenReader(text.slice(0, 200));
    return div;
  }

  function appendErrorMessage(retryText) {
    const msgs = $('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-bot';
    div.setAttribute('role', 'article');
    div.setAttribute('aria-label', 'Error message');
    div.innerHTML = `
      <div class="chat-bubble chat-bubble-error">
        I'm having trouble reaching my AI services right now. Please try again.
      </div>
      <button class="chat-retry-btn" aria-label="Retry sending your message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 .49-3.25"></path></svg>
        Retry
      </button>
    `;
    msgs.appendChild(div);

    // Bind retry button
    const retryBtn = div.querySelector('.chat-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        div.remove();
        if (retryText) sendMessage(retryText, true);
      });
    }

    scrollToBottom();
    announceToScreenReader('Error: Unable to reach AI services. Tap Retry to try again.');
    return div;
  }

  /* ============================================================
     TYPING INDICATOR
  ============================================================ */
  function showTyping() {
    const indicator = $('chat-typing');
    if (indicator) {
      indicator.classList.add('visible');
      scrollToBottom();
    }
  }

  function hideTyping() {
    const indicator = $('chat-typing');
    if (indicator) indicator.classList.remove('visible');
  }

  /* ============================================================
     API CALL
  ============================================================ */
  async function callChatAPI(message, history) {
    const payload = {
      message: message,
      conversation: history.slice(-CONFIG.MAX_HISTORY),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 429) {
        throw new Error('rate_limit');
      }
      if (!res.ok) {
        throw new Error(`api_error_${res.status}`);
      }

      const data = await res.json();
      return {
        answer: data.answer || data.reply || data.response || 'No response received.',
        sources: data.sources || [],
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('timeout');
      throw err;
    }
  }

  /* ============================================================
     SEND MESSAGE
  ============================================================ */
  async function sendMessage(text, isRetry = false) {
    if (isLoading) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Hide suggestions after first message
    if (!suggestionsHidden) {
      const suggestions = $('chat-suggestions');
      if (suggestions) {
        suggestions.style.display = 'none';
        suggestionsHidden = true;
      }
    }

    isLoading = true;
    lastFailedMessage = trimmed;

    // Disable input while loading
    const input = $('chat-input');
    const sendBtn = $('chat-send-btn');
    if (input) { input.value = ''; input.style.height = 'auto'; input.disabled = true; }
    if (sendBtn) sendBtn.disabled = true;

    // Render user message
    appendUserMessage(trimmed);

    // Show typing indicator
    showTyping();

    // Add to history optimistically
    conversationHistory.push({ role: 'user', content: trimmed });

    try {
      const result = await callChatAPI(trimmed, conversationHistory.slice(0, -1));
      hideTyping();

      conversationHistory.push({ role: 'assistant', content: result.answer });
      // Trim to bounded history
      if (conversationHistory.length > CONFIG.MAX_HISTORY * 2) {
        conversationHistory = conversationHistory.slice(-CONFIG.MAX_HISTORY * 2);
      }
      saveHistory(conversationHistory);

      appendBotMessage(result.answer, result.sources);
      lastFailedMessage = null;

    } catch (err) {
      hideTyping();
      // Remove the optimistic user message from history since we didn't get a response
      if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length - 1].role === 'user') {
        conversationHistory.pop();
      }
      appendErrorMessage(trimmed);
    } finally {
      isLoading = false;
      if (input) { input.disabled = false; input.focus(); }
      if (sendBtn) { updateSendButton(); }
    }
  }

  /* ============================================================
     AUTO-RESIZE TEXTAREA
  ============================================================ */
  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    const maxH = 120;
    const newH = Math.min(el.scrollHeight, maxH);
    el.style.height = newH + 'px';
  }

  function updateSendButton() {
    const input = $('chat-input');
    const sendBtn = $('chat-send-btn');
    if (!input || !sendBtn) return;
    sendBtn.disabled = input.value.trim().length === 0 || isLoading;
  }

  /* ============================================================
     OPEN / CLOSE
  ============================================================ */
  function openChat() {
    isOpen = true;
    const panel = $('chat-panel');
    const launcher = $('chat-launcher');
    if (panel) panel.classList.add('chat-open');
    if (launcher) launcher.setAttribute('aria-expanded', 'true');

    // Load persisted session history
    const saved = loadHistory();
    if (saved.length > 0) {
      conversationHistory = saved;
      // Re-render saved messages (without welcome)
      const msgs = $('chat-messages');
      if (msgs) {
        msgs.innerHTML = '';
        conversationHistory.forEach(msg => {
          if (msg.role === 'user') {
            appendUserMessage(msg.content);
          } else {
            appendBotMessage(msg.content, []);
          }
        });
        // Hide suggestions if there's prior history
        const suggestions = $('chat-suggestions');
        if (suggestions) { suggestions.style.display = 'none'; suggestionsHidden = true; }
      }
    } else {
      renderWelcome();
    }

    scrollToBottom(false);

    // Focus input
    setTimeout(() => {
      const input = $('chat-input');
      if (input) input.focus();
    }, 100);

    // Trap Escape to close
    document.addEventListener('keydown', handleEscape);
  }

  function closeChat() {
    isOpen = false;
    const panel = $('chat-panel');
    const launcher = $('chat-launcher');
    if (panel) panel.classList.remove('chat-open');
    if (launcher) {
      launcher.setAttribute('aria-expanded', 'false');
      launcher.focus(); // return focus to launcher on close
    }
    document.removeEventListener('keydown', handleEscape);
  }

  function clearChat() {
    clearHistory();
    conversationHistory = [];
    suggestionsHidden = false;
    const msgs = $('chat-messages');
    const suggestions = $('chat-suggestions');
    if (msgs) msgs.innerHTML = '';
    if (suggestions) suggestions.style.display = '';
    renderWelcome();
    const input = $('chat-input');
    if (input) input.focus();
  }

  function handleEscape(e) {
    if (e.key === 'Escape' && isOpen) closeChat();
  }

  /* ============================================================
     INITIALIZATION
  ============================================================ */
  function init() {
    if (document.getElementById('chat-launcher')) return; // Guard against duplicate init

    // Inject HTML into body
    const container = document.createElement('div');
    container.innerHTML = buildChatbotHTML();
    while (container.firstChild) {
      document.body.appendChild(container.firstChild);
    }

    // Bind launcher
    const launcher = $('chat-launcher');
    if (launcher) {
      launcher.addEventListener('click', () => {
        if (isOpen) closeChat(); else openChat();
      });
    }

    // Bind close
    const closeBtn = $('chat-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeChat);
    }

    // Bind clear
    const clearBtn = $('chat-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearChat);
    }

    // Bind send button
    const sendBtn = $('chat-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const input = $('chat-input');
        if (input) sendMessage(input.value);
      });
    }

    // Bind textarea input
    const input = $('chat-input');
    if (input) {
      input.addEventListener('input', () => {
        autoResizeTextarea(input);
        updateSendButton();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!sendBtn.disabled) sendMessage(input.value);
        }
      });
    }

    // Bind suggestion chips
    const suggestions = $('chat-suggestions');
    if (suggestions) {
      suggestions.addEventListener('click', (e) => {
        const chip = e.target.closest('.chat-chip');
        if (chip) {
          sendMessage(chip.textContent);
        }
      });
    }
  }

  /* ============================================================
     ENTRY POINT
  ============================================================ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
