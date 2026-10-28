# Implementation Plan

Improvements to answer speed, answer quality, robustness and features for BNS Legal Intelligence Desk.
Status: ✅ done · 🚧 deferred (reason given)

## Phase 1 — Latency ✅

| # | Item | Change |
|---|---|---|
| 1.1 | Answers appear only when complete | `POST /api/chat/query/stream` (NDJSON) + `apiStream` in the frontend |
| 1.2 | Hidden reasoning tokens slow `gpt-oss-20b` | `reasoning_effort="low"`, `include_reasoning=False`, `max_completion_tokens` |
| 1.3 | Index rebuilt from Hugging Face on every process start | Reuse `statutory_search.db`; warm it in a background thread at startup; lazy `datasets` import |
| 1.4 | Sync Supabase/Groq calls inside `async def` block the event loop | API endpoints are plain `def` (threadpool) |
| 1.5 | 6–8 sequential Supabase round trips per query | Parallel prep on `_io_pool`, single-row ownership check, 5-min user cache, assistant save after the stream ends, no session-list refetch |

## Phase 2 — Retrieval quality ✅

| # | Problem | Change |
|---|---|---|
| 2.1 | No ranking — "murder" returned Sections 1 and 3 | `ORDER BY bm25(...)` with section-title column weighted higher |
| 2.2 | Every word is AND-ed, so natural questions ("What constitutes murder…") match nothing | Stopword list for question words; AND query first, OR fallback |
| 2.3 | Any number is treated as a section number ("7 years", "2023") | Only `section/sec/s./§ N` or a query that is just a number |
| 2.4 | Only 2 results, from per-table limits | Top results merged across acts by bm25 score (max 4) |
| 2.5 | Follow-ups ("what is the punishment for that?") retrieve nothing | If nothing is found, retry with the previous user message added |
| 2.6 | Render's disk is ephemeral, so the DB is rebuilt on each cold start | `statutory_search.db` is committed (2.5 MB) instead of gitignored |

## Phase 3 — Robustness ✅

| # | Item | Change |
|---|---|---|
| 3.1 | A Groq failure fails the whole answer | Fallback model (`FALLBACK_MODEL`, default `openai/gpt-oss-120b`) if the primary fails before any text is sent |
| 3.2 | Identical questions are regenerated every time | In-memory LRU answer cache for first-turn questions (same text + act filter + language) |
| 3.3 | No abuse protection on the paid LLM call | Per-user rate limit on query endpoints (`RATE_LIMIT_PER_MINUTE`, default 20) → HTTP 429 |
| 3.4 | Slow requests can't be diagnosed | Per-stage timing log line (`prep`, `first_token`, `total`) for each query |
| 3.5 | OAuth callback puts raw exception text in the redirect URL | `quote()` the message as `/auth/google` already does |
| 3.6 | Errors were saved as assistant replies | Failed generations are not saved (done in Phase 1) |
| 3.7 | Pressing Stop didn't stop the server, which kept generating and saved the full answer | The stream checks for client disconnect between chunks, closes the model stream and saves nothing |
| 3.8 | `next@15.5.24` had critical advisories (incl. image-optimizer RCE) | Upgraded to `15.5.28`; `npm audit` reports 0 vulnerabilities |

## Phase 4 — Features ✅

| # | Feature | Change |
|---|---|---|
| 4.1 | Markdown shown as raw text (`**`, `###`) | `react-markdown` + `remark-gfm` rendering for assistant messages |
| 4.2 | Clickable citations | Retrieved-provision cards open a panel with the full section text (`GET /api/sections/{act}/{section}`) |
| 4.3 | Stop generation | Stop button aborts the stream (`AbortController`); partial answer is kept on screen but not saved |
| 4.4 | Regenerate / retry | Re-asks the last question with `regenerate: true`: the old answer is deleted, the question is not saved twice, and the answer cache is bypassed. A question left unanswered (stopped early) gets a Retry button |
| 4.5 | Copy / export | Copy an answer to the clipboard; download the conversation as a Markdown brief; print-friendly CSS for PDF |
| 4.6 | Feedback | 👍/👎 per answer → `message_feedback` table (`POST /api/feedback`); see `supabase_setup.sql` |
| 4.7 | Multilingual answers | Language selector (English, Hindi, Marathi, Tamil, Telugu, Bengali, Gujarati, Kannada), remembered per browser; voice input and read-aloud use the matching locale. Non-English answers use `MULTILINGUAL_MODEL` (`gpt-oss-120b`) because `gpt-oss-20b` answered Tamil/Kannada/Gujarati requests in English in testing |

## Phase 5 — Hygiene ✅

- `.gitignore` cleaned (stray PowerShell lines removed); `frontend/.next-dev/` untracked.
- `.env.example` added; `FRONTEND_URL`, `REASONING_EFFORT`, `FALLBACK_MODEL`, `RATE_LIMIT_PER_MINUTE` documented.
- Legacy Gradio app `chat.py` and `templates/login.html` removed (still in git history). `static/` stays: the frontend loads its background images from the backend.
- `pytest` tests for retrieval and the API (Supabase and Groq stubbed): `pytest tests`.

## Deferred 🚧

| Item | Why |
|---|---|
| IPC → BNS / CrPC → BNSS / IEA → BSA lookup | The dataset has no correspondence data. A mapping table must come from an authoritative source (e.g. the official correspondence tables) — it must not be generated by the model or written from memory. Add it as a data file plus a lookup table when a source is chosen. |
| Synonym / concept search ("mob lynching" → BNS 103(2)) | Keyword search can't match words the statute never uses; this needs the embedding search below. |
| Embedding / hybrid search | Needs an embedding model (e.g. `sentence-transformers` + `sqlite-vec`, ~500 MB of dependencies) which strains Render's free tier. Revisit once bm25 results are measured on real questions. |
| Rate limit / cache shared across instances | In-memory is fine for one Render instance; move to Redis if the backend is scaled out. |
| Supabase RLS | The backend uses one server key; enabling RLS needs the service-role key or per-user JWTs. |
