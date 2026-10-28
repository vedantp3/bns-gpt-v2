# CLAUDE.md

Guidance for working in this repository.

## What this is

**BNS Legal Intelligence Desk (bns-gpt-v2)** — a RAG chat assistant for Indian criminal law:
Bharatiya Nyaya Sanhita (BNS), Bharatiya Nagarik Suraksha Sanhita (BNSS) and Bharatiya Sakshya
Adhiniyam (BSA). Users sign in with Google, ask questions (typed or by voice, in English or an
Indian language), and get a streamed markdown answer grounded in retrieved statutory sections.
Chat history is saved per user. See `IMPLEMENTATION_PLAN.md` for what was improved and what is deferred.

## Layout

| Path | Role |
|---|---|
| `app.py` | FastAPI app: Google OAuth, cookie session, JSON/NDJSON API for the Next.js frontend, rate limit, answer cache, timing logs. Entry point. |
| `legal_ai.py` | Retrieval + generation: SQLite FTS5 index (loaded, or built from Hugging Face if missing), ranked search, Groq LLM calls with fallback and language support. |
| `database.py` | Supabase client and all persistence (users, chat_sessions, chat_messages, message_feedback). |
| `auth.py` | `itsdangerous` signed session token (`app_session` cookie, 30 days). |
| `supabase_setup.sql` | Schema for the Supabase tables (RLS disabled; access checked in app code). |
| `statutory_search.db` | Prebuilt FTS5 index, **committed** so Render cold starts don't rebuild it. Delete it to force a rebuild from Hugging Face. |
| `static/images/` | Original JPG photos (still mounted at `/static`, no longer referenced by the frontend). |
| `frontend/public/images/` | UI artwork: `courtroom.webp` (login), `police-desk.webp` (chat welcome), hand-drawn SVGs `scales.svg` (logo/avatar/favicon), `court-facade.svg`, `jali-gold.svg` / `jali-navy.svg` (tileable Indian lattice backgrounds). |
| `tests/` | pytest: `test_retrieval.py` (real index) and `test_api.py` (Supabase + Groq faked in memory). |
| `frontend/` | Next.js 15 / React 19 app (App Router, TypeScript, plain CSS). |
| `frontend/app/page.tsx` | Landing/login page (server component); links to `${API_BASE_URL}/auth/google`. |
| `frontend/app/chat/page.tsx` | The whole chat UI (client component): sessions sidebar, corpus + language selectors, streamed markdown answers, copy/👍👎/regenerate, stop, citation drawer, export/print, voice in/out. |
| `frontend/lib/api.ts` | `apiFetch` (JSON) and `apiStream` (NDJSON reader with abort signal). |

## Request flow (`POST /api/chat/query/stream`, used by the frontend)

1. Auth: `app_session` cookie → `get_user_by_id`, cached in-process for 5 minutes. Per-user rate limit (429).
2. `_prepare_query`: ownership check + history load run concurrently on `_io_pool` (or a new session
   is created); the user message is saved in the background. With `regenerate: true` the last
   answer is deleted (synchronously) and the question is not saved again.
3. `route_and_search(message, act, previous_question)`:
   - explicit section references (`section 103`, `s. 64`, `§ 23`, or a bare number) → direct lookup;
   - otherwise stopword-filtered terms → FTS5 OR candidates → ranked by terms in the section title,
     then term coverage, then shorter title, then bm25 (`_rank_key`); top 4 across acts;
   - short follow-ups with "that/this/it…" are searched together with the previous question.
4. `stream_response`: Groq `openai/gpt-oss-20b` (English) or `MULTILINGUAL_MODEL` (`gpt-oss-120b`, other
   languages), `reasoning_effort="low"`, hidden reasoning off, last 10 history messages. If the
   first model fails before producing text, the other one is tried.
5. NDJSON events: `meta` (session id/title, retrievals without full text), `delta`*, then `done` or
   `error`. The answer is saved after `done`; errors and client disconnects (Stop button) save nothing.
   First questions in a session are cached in memory (question + act + language) and replayed.
6. One `[query] ... prep= first_token= total=` log line per request.

`POST /api/chat/query` is the non-streaming equivalent. Other endpoints: session CRUD under
`/api/chat/sessions`, `GET /api/sections/{act}/{section}` (citation drawer), `POST /api/feedback`.

API endpoints are plain `def` so blocking Supabase/Groq calls run in FastAPI's threadpool; the
stream generator is `async` so it can detect disconnects. The index loads in a background thread at startup.

## Running locally

Backend (Python 3.10+):

```bash
pip install -r requirements.txt -r requirements-dev.txt
python app.py
```

Runs on `PORT` (default 7860). `start.sh` is the production command.

Tests:

```bash
python -m pytest tests -q
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Dev output goes to `.next-dev`, prod to `.next`. `npm run build` cleans both first. Deployed to Vercel.

## Configuration

See `.env.example`. Required: `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`SUPABASE_URL`, `SUPABASE_KEY`, `SECRET_KEY`, `FRONTEND_URL` (an `https://` value switches the cookie
to `SameSite=None; Secure`). Optional: `PORT`, `REASONING_EFFORT`, `FALLBACK_MODEL`,
`MULTILINGUAL_MODEL`, `RATE_LIMIT_PER_MINUTE`. Frontend: `NEXT_PUBLIC_API_BASE_URL`.

Google OAuth redirect URI must be `<backend base URL>/auth/callback`. The `message_feedback`
table must exist in Supabase (block 4 of `supabase_setup.sql`) for 👍/👎 to work.

## Conventions

- Backend: plain functions, type hints, module-level clients. Keep `legal_ai.py` free of FastAPI
  imports; `app.py` is the only HTTP layer. Tests monkeypatch the names imported into `app`.
- Retrieval changes: add a case to `tests/test_retrieval.py` for the query you are fixing.
- Never invent statutory facts in hardcoded answers or mapping tables; `_ACT_REFERENCE_FACTS` is the
  only place for such constants, and new legal data needs an authoritative source.
- Frontend: one large client component per page, `useState` hooks, class names styled in
  `app/globals.css` (print styles at the end). Assistant messages render with `react-markdown` + `remark-gfm`.
- Visual design: navy / brass / parchment tokens on `:root` in `globals.css`; Fraunces (display) and
  Inter (UI) via `next/font` in `layout.tsx`. Chat page is a full-height app shell (sidebar becomes an
  off-canvas drawer under 900px). Grid containers holding single-line ellipsis text need
  `minmax(0, 1fr)` columns, or long session titles widen the layout on mobile.
- Icons are inline SVG paths in `iconPaths` (`chat/page.tsx`); don't add an icon library for one icon.
- Don't use the State Emblem of India (Lion Capital) in artwork — its use is legally restricted.
- The prompt keeps the `**Short Answer**` heading in English in every language; the voice TTS
  regex in `chat/page.tsx` depends on it.
- Rate limiter and answer cache are in-memory (per process); fine for a single Render instance.

## Known gotchas

- On Windows, writing Python regexes through a bash heredoc can turn `\b` into a backspace byte;
  edit such files with an editor, not shell heredocs.
- `gpt-oss-20b` often ignores "answer in Tamil/Kannada/Gujarati"; that's why non-English uses 120b.
- Keyword search can't find concepts the statute words differently (e.g. "mob lynching").
- Supabase uses the key from `SUPABASE_KEY` with RLS disabled — keep it server-side only.
