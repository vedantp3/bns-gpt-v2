"""
FastAPI backend for the BNS Legal Intelligence application.

This version exposes JSON APIs for a separate Next.js frontend.
"""

import asyncio
import json
import os
import threading
import time
import uuid
from collections import OrderedDict, defaultdict, deque
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote

from authlib.integrations.starlette_client import OAuth
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from auth import create_session_token, decode_session_token
from database import (
    create_chat_session,
    get_or_create_user,
    get_session_messages,
    get_user_by_id,
    get_user_sessions,
    delete_chat_session,
    delete_last_assistant_message,
    save_feedback,
    save_message,
    update_session_title,
    user_owns_session,
)
from legal_ai import (
    build_statutory_context,
    generate_response,
    get_section,
    normalize_language,
    route_and_search,
    stream_response,
    warm_up,
)

load_dotenv()

SECRET_KEY = os.environ.get("SECRET_KEY", "change-this-secret-in-production")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip("/")

if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
    print("[WARNING] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. OAuth will not work.")

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the search index in the background so the first user query doesn't pay for it.
    threading.Thread(target=warm_up, daemon=True).start()
    yield


app = FastAPI(title="BNS Legal Intelligence API", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Runs independent Supabase / search calls of a chat query concurrently.
_io_pool = ThreadPoolExecutor(max_workers=16)

oauth = OAuth()
oauth.register(
    name="google",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile", "prompt": "select_account"},
)


class QueryRequest(BaseModel):
    message: str
    act_filter: str = "All Acts"
    session_id: str | None = None
    language: str = "English"
    regenerate: bool = False  # re-answer the session's last question instead of adding a new one


_USER_CACHE_TTL_SECONDS = 300
_user_cache: dict[str, tuple[float, dict]] = {}


def _get_user_cached(user_id: str) -> dict | None:
    cached = _user_cache.get(user_id)
    if cached and time.monotonic() - cached[0] < _USER_CACHE_TTL_SECONDS:
        return cached[1]

    user = get_user_by_id(user_id)
    if user:
        _user_cache[user_id] = (time.monotonic(), user)
    return user


def get_current_user_or_401(request: Request) -> tuple[str, dict]:
    token = request.cookies.get("app_session")
    user_id = decode_session_token(token) if token else None
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required.")

    user = _get_user_cached(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User session is invalid.")
    return user_id, user


def _require_owned_session(user_id: str, session_id: str) -> None:
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found.")
    if not user_owns_session(user_id, session_id):
        raise HTTPException(status_code=404, detail="Session not found.")


def _session_title(message: str) -> str:
    return message[:50] + ("..." if len(message) > 50 else "")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.api_route("/", methods=["GET", "HEAD"])
async def root(request: Request):
    if request.method == "HEAD":
        return Response(status_code=204)
    return RedirectResponse(url=FRONTEND_URL, status_code=302)


@app.api_route("/auth/google", methods=["GET", "HEAD"])
async def login_with_google(request: Request):
    if request.method == "HEAD":
        return Response(status_code=204)

    redirect_uri = str(request.base_url).rstrip("/") + "/auth/callback"
    try:
        return await oauth.google.authorize_redirect(request, redirect_uri)
    except Exception as exc:
        message = quote(str(exc))
        return RedirectResponse(
            url=f"{FRONTEND_URL}/?error=oauth&message={message}",
            status_code=302,
        )


@app.get("/auth/callback")
async def google_auth_callback(request: Request):
    try:
        token = await oauth.google.authorize_access_token(request)
    except Exception as exc:
        return RedirectResponse(url=f"{FRONTEND_URL}/?error=oauth&message={quote(str(exc))}", status_code=302)

    user_info = token.get("userinfo")
    if not user_info:
        return RedirectResponse(url=f"{FRONTEND_URL}/?error=userinfo", status_code=302)

    try:
        user = get_or_create_user(
            google_id=user_info["sub"],
            email=user_info.get("email", ""),
            name=user_info.get("name", "User"),
            avatar_url=user_info.get("picture", ""),
        )
    except Exception as exc:
        return RedirectResponse(url=f"{FRONTEND_URL}/?error=db&message={quote(str(exc))}", status_code=302)

    session_token = create_session_token(user["id"])
    response = RedirectResponse(url=f"{FRONTEND_URL}/chat", status_code=302)
    is_production = FRONTEND_URL.startswith("https://")
    response.set_cookie(
        key="app_session",
        value=session_token,
        httponly=True,
        samesite="none" if is_production else "lax",
        secure=is_production,
        max_age=30 * 86400,
    )
    return response


@app.post("/auth/logout")
async def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(key="app_session")
    return response


@app.get("/api/auth/session")
def auth_session(request: Request):
    token = request.cookies.get("app_session")
    user_id = decode_session_token(token) if token else None
    if not user_id:
        return JSONResponse({"authenticated": False}, status_code=401)

    user = _get_user_cached(user_id)
    if not user:
        return JSONResponse({"authenticated": False}, status_code=401)

    return {
        "authenticated": True,
        "user": {
            "id": user_id,
            "name": user.get("name", "User"),
            "email": user.get("email", ""),
            "avatar_url": user.get("avatar_url", ""),
        },
    }


@app.get("/api/chat/sessions")
def list_chat_sessions(request: Request):
    user_id, _ = get_current_user_or_401(request)
    sessions = get_user_sessions(user_id)
    return {"sessions": [{"id": session_id, "title": title} for title, session_id in sessions]}


@app.get("/api/chat/sessions/{session_id}")
def read_chat_session(session_id: str, request: Request):
    user_id, _ = get_current_user_or_401(request)
    sessions = dict((sid, title) for title, sid in get_user_sessions(user_id))
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found.")

    messages = get_session_messages(session_id)
    return {
        "session": {
            "id": session_id,
            "title": sessions[session_id],
            "messages": [{"role": role, "content": content} for role, content in messages],
        }
    }


@app.post("/api/chat/sessions")
def create_session(request: Request):
    user_id, _ = get_current_user_or_401(request)
    session_id = create_chat_session(user_id, "New Legal Brief")
    return {"session_id": session_id}


@app.delete("/api/chat/sessions/{session_id}")
def delete_session(session_id: str, request: Request):
    user_id, _ = get_current_user_or_401(request)
    _require_owned_session(user_id, session_id)

    delete_chat_session(session_id)
    return {"ok": True}


@app.get("/api/sections/{act}/{section_number}")
def read_section(act: str, section_number: str, request: Request):
    get_current_user_or_401(request)
    section = get_section(act, section_number)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found.")

    act_name, number, title, chapter, text = section
    return {"act": act_name, "section": number, "title": title, "chapter": chapter, "text": text}


class FeedbackRequest(BaseModel):
    session_id: str
    rating: Literal[1, -1]
    question: str = Field(default="", max_length=4000)
    answer: str = Field(max_length=20000)
    comment: str | None = Field(default=None, max_length=2000)


@app.post("/api/feedback")
def submit_feedback(payload: FeedbackRequest, request: Request):
    user_id, _ = get_current_user_or_401(request)
    _require_owned_session(user_id, payload.session_id)
    save_feedback(
        session_id=payload.session_id,
        user_id=user_id,
        rating=payload.rating,
        question=payload.question,
        answer=payload.answer,
        comment=payload.comment,
    )
    return {"ok": True}


class _RateLimiter:
    """Sliding one-minute window per user. In-memory, so it is per process."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > 60:
                hits.popleft()
            if len(hits) >= self.per_minute:
                raise HTTPException(
                    status_code=429,
                    detail="Too many questions in a short time. Please wait a minute and try again.",
                )
            hits.append(now)


_query_limiter = _RateLimiter(int(os.environ.get("RATE_LIMIT_PER_MINUTE", "20")))


class _AnswerCache:
    """LRU cache of answers to first questions in a session (no history, so the answer
    depends only on the question, act filter and language)."""

    def __init__(self, max_entries: int = 256, ttl_seconds: int = 24 * 3600):
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self._entries: OrderedDict[tuple, tuple[float, str]] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def key(message: str, act_filter: str, language: str) -> tuple:
        return (" ".join(message.lower().split()), act_filter, language)

    def get(self, key: tuple) -> str | None:
        with self._lock:
            entry = self._entries.get(key)
            if not entry or time.monotonic() - entry[0] > self.ttl_seconds:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return entry[1]

    def put(self, key: tuple, answer: str) -> None:
        with self._lock:
            self._entries[key] = (time.monotonic(), answer)
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)


_answer_cache = _AnswerCache()


def _completed(value=None) -> Future:
    future: Future = Future()
    future.set_result(value)
    return future


@dataclass
class _PreparedQuery:
    session_id: str
    session_title: str | None
    message: str
    language: str
    history: list[dict]
    retrieved: list[tuple[str, str, str, str, str]]
    statutory_context: str | None
    user_saved: Future  # the user-message insert
    cache_key: tuple | None  # set when the answer is cacheable (first question in a session)
    read_cache: bool  # False for regenerate, which must produce a new answer
    started: float

    def cached_answer(self) -> str | None:
        return _answer_cache.get(self.cache_key) if self.cache_key and self.read_cache else None


def _prepare_query(user_id: str, payload: QueryRequest) -> _PreparedQuery:
    """Resolve the session, load history, save the user message and retrieve statutes,
    running the independent Supabase calls concurrently."""
    started = time.perf_counter()
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    _query_limiter.check(user_id)

    language = normalize_language(payload.language)
    filter_target = "ALL" if payload.act_filter == "All Acts" else payload.act_filter

    session_id = payload.session_id
    session_title = None
    save_user_message = True
    if session_id:
        ownership_future = _io_pool.submit(_require_owned_session, user_id, session_id)
        history_future = _io_pool.submit(get_session_messages, session_id)
        ownership_future.result()
        prior_messages = history_future.result()

        if payload.regenerate:
            # Replace the last answer to this question instead of adding a second one.
            if prior_messages and prior_messages[-1][0] == "assistant":
                # Synchronous: running it in the background could delete the new answer instead.
                delete_last_assistant_message(session_id)
                prior_messages = prior_messages[:-1]
            if prior_messages and prior_messages[-1] == ("user", message):
                prior_messages = prior_messages[:-1]
                save_user_message = False

        if not prior_messages:
            session_title = _session_title(message)
            _io_pool.submit(update_session_title, session_id, message)
    else:
        session_title = _session_title(message)
        session_id = create_chat_session(user_id, session_title)
        prior_messages = []

    user_saved = (
        _io_pool.submit(save_message, session_id, user_id, "user", message) if save_user_message else _completed()
    )

    previous_question = next((content for role, content in reversed(prior_messages) if role == "user"), None)
    retrieved = route_and_search(message, filter_target, previous_question)

    return _PreparedQuery(
        session_id=session_id,
        session_title=session_title,
        message=message,
        language=language,
        history=[{"role": role, "content": content} for role, content in prior_messages],
        retrieved=retrieved,
        statutory_context=build_statutory_context(retrieved),
        user_saved=user_saved,
        cache_key=None if prior_messages else _AnswerCache.key(message, filter_target, language),
        read_cache=not payload.regenerate,
        started=started,
    )


def _save_assistant_message(user_saved, session_id: str, user_id: str, content: str) -> None:
    # The user message must land first so history stays in order.
    user_saved.result()
    save_message(session_id, user_id, "assistant", content)


def _retrievals_payload(retrieved, include_text: bool) -> list[dict]:
    items = []
    for act, section, title_sec, chapter, text in retrieved:
        item = {"act": act, "section": section, "title": title_sec, "chapter": chapter}
        if include_text:
            item["text"] = text
        items.append(item)
    return items


def _log_timing(prepared: _PreparedQuery, prep_done: float, first_token: float | None, outcome: str) -> None:
    def ms(moment: float | None) -> str:
        return f"{(moment - prepared.started) * 1000:.0f}ms" if moment else "-"

    print(
        f"[query] session={prepared.session_id} sections={len(prepared.retrieved)} lang={prepared.language} "
        f"prep={ms(prep_done)} first_token={ms(first_token)} total={ms(time.perf_counter())} {outcome}"
    )


@app.post("/api/chat/query")
def chat_query(payload: QueryRequest, request: Request):
    user_id, _ = get_current_user_or_401(request)
    prepared = _prepare_query(user_id, payload)
    prep_done = time.perf_counter()

    cached = prepared.cached_answer()
    response = cached or generate_response(
        prepared.message, prepared.history, prepared.statutory_context, prepared.language
    )
    failed = response.startswith("⚠️")
    if not failed:
        _save_assistant_message(prepared.user_saved, prepared.session_id, user_id, response)
        if prepared.cache_key and not cached:
            _answer_cache.put(prepared.cache_key, response)
    _log_timing(prepared, prep_done, None, "cached" if cached else ("error" if failed else "ok"))

    return {
        "session_id": prepared.session_id,
        "message": {"role": "assistant", "content": response},
        "retrievals": _retrievals_payload(prepared.retrieved, include_text=True),
    }


@app.post("/api/chat/query/stream")
def chat_query_stream(payload: QueryRequest, request: Request):
    """Same as /api/chat/query, but streams the answer as newline-delimited JSON events:
    {"type": "meta", ...}, then {"type": "delta", "content": ...}*, then "done" or "error"."""
    user_id, _ = get_current_user_or_401(request)
    prepared = _prepare_query(user_id, payload)
    prep_done = time.perf_counter()

    async def events():
        yield json.dumps({
            "type": "meta",
            "session_id": prepared.session_id,
            "session_title": prepared.session_title,
            "retrievals": _retrievals_payload(prepared.retrieved, include_text=False),
        }) + "\n"

        cached = prepared.cached_answer()
        chunks = iter([cached]) if cached else stream_response(
            prepared.message, prepared.history, prepared.statutory_context, prepared.language
        )

        parts: list[str] = []
        first_token = None
        try:
            while True:
                # Stop generating (and don't save) once the user presses Stop or leaves.
                if await request.is_disconnected():
                    getattr(chunks, "close", lambda: None)()
                    _log_timing(prepared, prep_done, first_token, "client_disconnected")
                    return
                delta = await run_in_threadpool(next, chunks, None)
                if delta is None:
                    break
                if first_token is None:
                    first_token = time.perf_counter()
                parts.append(delta)
                yield json.dumps({"type": "delta", "content": delta}) + "\n"
        except asyncio.CancelledError:
            # Starlette cancels the stream when the client disconnects mid-write.
            getattr(chunks, "close", lambda: None)()
            _log_timing(prepared, prep_done, first_token, "client_disconnected")
            raise
        except Exception as exc:
            _log_timing(prepared, prep_done, first_token, f"error={exc}")
            yield json.dumps({"type": "error", "detail": f"Error generating response: {exc}"}) + "\n"
            return

        answer = "".join(parts)
        _io_pool.submit(_save_assistant_message, prepared.user_saved, prepared.session_id, user_id, answer)
        if prepared.cache_key and not cached:
            _answer_cache.put(prepared.cache_key, answer)
        _log_timing(prepared, prep_done, first_token, "cached" if cached else "ok")
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 7860))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
