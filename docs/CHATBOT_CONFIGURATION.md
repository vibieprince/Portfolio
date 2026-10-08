# 📖 Portfolio Chatbot Configuration & Diagnostics Guide

This document provides a complete environment, secrets, and diagnostic reference for the **Prince Portfolio AI Chatbot & Single-Source PDF RAG Pipeline**.

---

## 🛠️ Required Environment Variables Summary

| Variable Name | Required / Optional | Where Used | Purpose |
|---|:---:|---|---|
| `GEMINI_API_KEY` | **REQUIRED** | Vercel, GitHub Actions, `ingest.py` | Primary Gemini API key for embeddings (`gemini-embedding-2`) and text generation (`gemini-3.5-flash-lite`). |
| `SUPABASE_URL` | **REQUIRED** | Vercel, GitHub Actions, `ingest.py` | Supabase project REST URL (`https://<project-id>.supabase.co`). |
| `SUPABASE_SERVICE_KEY` | **REQUIRED** | Vercel, GitHub Actions, `ingest.py` | Supabase Service Role Key (bypasses RLS for vector search and ingestion). Also accepts `SUPABASE_SERVICE_ROLE_KEY`. |
| `MISTRAL_API_KEY` | **OPTIONAL** | Vercel, GitHub Actions | Fallback LLM API key when Gemini experiences 503/429 outages. |
| `GEMINI_LLM_MODEL` | Optional | Vercel | Primary Gemini text model (Default: `gemini-3.5-flash-lite`). Also accepts `LLM_MODEL`. |
| `MISTRAL_LLM_MODEL` | Optional | Vercel | Mistral fallback model (Default: `mistral-small-latest`). |
| `EMBEDDING_MODEL` | Optional | Vercel, GitHub Actions, `ingest.py` | Embedding model (Default: `gemini-embedding-2`). |
| `EMBEDDING_DIMENSION` | Optional | Vercel, GitHub Actions, `ingest.py` | Vector dimensionality (Default: `768`). |
| `GITHUB_TOKEN` | Optional | Vercel | GitHub API token for `/api/github` metric caching. |
| `CHAT_DEBUG` | Optional | Vercel | Set to `true` for verbose execution timing logs in Vercel. |

---

## 🔒 Vercel Deployment Settings Checklist

Ensure the following variables are configured under **Vercel Dashboard $\rightarrow$ Project $\rightarrow$ Settings $\rightarrow$ Environment Variables**:

- [x] `GEMINI_API_KEY`
- [x] `SUPABASE_URL`
- [x] `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)
- [ ] `MISTRAL_API_KEY` *(Recommended for high-availability fallback)*

---

## 🔑 GitHub Actions Repository Secrets Checklist

Ensure the following secrets are configured under **GitHub Repository $\rightarrow$ Settings $\rightarrow$ Secrets and variables $\rightarrow$ Actions**:

- [x] `GEMINI_API_KEY`
- [x] `SUPABASE_URL`
- [x] `SUPABASE_SERVICE_KEY`
- [ ] `MISTRAL_API_KEY` *(Optional)*

---

## 🔍 How to Correlate Browser Failures using `requestId`

Every `/api/chat` request generates a unique request ID (e.g. `req-a1b2c3d4`).

1. When a failure occurs, the server response or Vercel log will tag every step with `[CHAT req-a1b2c3d4]`.
2. Search the Vercel Function logs using `req-<id>` to view the exact execution timeline:
   ```text
   [CHAT req-a1b2c3d4] Request received at /api/chat
   [CHAT req-a1b2c3d4] Config validated: Gemini=OK, Mistral=OK, Supabase=OK
   [CHAT req-a1b2c3d4] Query embedding generated (768 dims)
   [CHAT req-a1b2c3d4] Supabase RPC match_documents retrieved 6 chunks
   [CHAT req-a1b2c3d4] Calling primary Gemini model: gemini-3.5-flash-lite
   [CHAT req-a1b2c3d4] Gemini HTTP status: 200
   [CHAT req-a1b2c3d4] Response returned successfully
   ```

---

## 🛡️ Privacy & Security Safeguards

1. **No Secret Leakage:** Logs output `configured` or `missing` for credentials. Key strings are never printed.
2. **Controlled Error Responses:** Upstream stack traces and raw HTTP error bodies are kept strictly inside Vercel Function logs. Visitors receive clean JSON responses with safe error categories (`AI_SERVICE_TEMPORARILY_UNAVAILABLE`, `RATE_LIMIT_EXCEEDED`, `INVALID_REQUEST`).
