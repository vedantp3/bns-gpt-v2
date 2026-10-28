"""API tests with Supabase and Groq replaced by in-memory fakes."""

import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient

import app as app_module
from auth import create_session_token

USER_ID = str(uuid.uuid4())
OTHER_USER_ID = str(uuid.uuid4())


class FakeDb:
    def __init__(self):
        self.sessions: dict[str, dict] = {}
        self.messages: list[dict] = []
        self.feedback: list[dict] = []

    def create_chat_session(self, user_id, title="New Chat"):
        session_id = str(uuid.uuid4())
        self.sessions[session_id] = {"user_id": user_id, "title": title}
        return session_id

    def user_owns_session(self, user_id, session_id):
        return self.sessions.get(session_id, {}).get("user_id") == user_id

    def get_session_messages(self, session_id):
        return [(m["role"], m["content"]) for m in self.messages if m["session_id"] == session_id]

    def save_message(self, session_id, user_id, role, content):
        self.messages.append({"session_id": session_id, "role": role, "content": content})

    def update_session_title(self, session_id, title):
        self.sessions[session_id]["title"] = title[:50]

    def delete_last_assistant_message(self, session_id):
        for i in range(len(self.messages) - 1, -1, -1):
            if self.messages[i]["session_id"] == session_id and self.messages[i]["role"] == "assistant":
                del self.messages[i]
                return

    def save_feedback(self, **row):
        self.feedback.append(row)


@pytest.fixture
def db(monkeypatch):
    fake = FakeDb()
    for name in (
        "create_chat_session",
        "user_owns_session",
        "get_session_messages",
        "save_message",
        "update_session_title",
        "delete_last_assistant_message",
        "save_feedback",
    ):
        monkeypatch.setattr(app_module, name, getattr(fake, name))
    monkeypatch.setattr(app_module, "get_user_by_id", lambda user_id: {"name": "Test", "email": "t@example.com"})
    monkeypatch.setattr(app_module, "_answer_cache", app_module._AnswerCache())
    monkeypatch.setattr(app_module, "_query_limiter", app_module._RateLimiter(100))
    app_module._user_cache.clear()
    return fake


@pytest.fixture
def llm(monkeypatch):
    """Records each generation call and streams a fixed answer."""
    calls = []

    def fake_stream(message, history, context, language="English"):
        calls.append({"message": message, "history": history, "context": context, "language": language})
        yield "**Short Answer**\n"
        yield f"Answer {len(calls)}"

    monkeypatch.setattr(app_module, "stream_response", fake_stream)
    return calls


@pytest.fixture
def client():
    test_client = TestClient(app_module.app)
    test_client.cookies.set("app_session", create_session_token(USER_ID))
    return test_client


def ask(client, **body) -> list[dict]:
    response = client.post("/api/chat/query/stream", json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines()]


def wait_for(predicate, timeout=2.0):
    # The assistant message is saved on a worker thread after the stream ends.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


def test_stream_creates_session_streams_answer_and_saves_both_messages(client, db, llm):
    events = ask(client, message="What is murder under BNS?")

    assert [event["type"] for event in events] == ["meta", "delta", "delta", "done"]
    meta = events[0]
    assert meta["session_title"] == "What is murder under BNS?"
    assert meta["retrievals"][0] == {"act": "BNS", "section": "101", "title": "Murder", "chapter": meta["retrievals"][0]["chapter"]}
    assert "text" not in meta["retrievals"][0]

    session_id = meta["session_id"]
    wait_for(lambda: len(db.messages) == 2)
    assert db.get_session_messages(session_id) == [
        ("user", "What is murder under BNS?"),
        ("assistant", "**Short Answer**\nAnswer 1"),
    ]


def test_follow_up_gets_history_and_previous_question_context(client, db, llm):
    session_id = ask(client, message="What is theft under BNS")[0]["session_id"]
    wait_for(lambda: len(db.messages) == 2)

    events = ask(client, message="what is the punishment for that?", session_id=session_id)

    assert events[0]["retrievals"][0]["section"] == "303"
    assert events[0]["session_title"] is None
    assert [m["role"] for m in llm[1]["history"]] == ["user", "assistant"]


def test_generation_error_is_reported_and_not_saved(client, db, monkeypatch):
    def failing_stream(*args, **kwargs):
        raise RuntimeError("groq down")
        yield  # pragma: no cover

    monkeypatch.setattr(app_module, "stream_response", failing_stream)
    events = ask(client, message="murder")

    assert events[-1]["type"] == "error"
    assert "groq down" in events[-1]["detail"]
    time.sleep(0.1)
    assert [m["role"] for m in db.messages] == ["user"]


def test_regenerate_replaces_last_answer(client, db, llm):
    session_id = ask(client, message="murder")[0]["session_id"]
    wait_for(lambda: len(db.messages) == 2)

    ask(client, message="murder", session_id=session_id, regenerate=True)

    wait_for(lambda: db.get_session_messages(session_id)[-1] == ("assistant", "**Short Answer**\nAnswer 2"))
    assert db.get_session_messages(session_id) == [("user", "murder"), ("assistant", "**Short Answer**\nAnswer 2")]
    assert llm[1]["history"] == []


def test_first_question_answers_are_cached(client, db, llm):
    first = ask(client, message="What is murder?")
    second = ask(client, message="  what is   MURDER? ")

    assert len(llm) == 1
    assert "".join(e["content"] for e in second if e["type"] == "delta") == "**Short Answer**\nAnswer 1"
    assert first[0]["session_id"] != second[0]["session_id"]


def test_language_is_passed_through_and_part_of_cache_key(client, db, llm):
    ask(client, message="murder", language="Hindi")
    ask(client, message="murder", language="Klingon")  # unsupported → English

    assert [call["language"] for call in llm] == ["Hindi", "English"]


def test_rate_limit(client, db, llm, monkeypatch):
    monkeypatch.setattr(app_module, "_query_limiter", app_module._RateLimiter(2))
    ask(client, message="murder")
    ask(client, message="theft")

    response = client.post("/api/chat/query/stream", json={"message": "cheating"})
    assert response.status_code == 429


def test_session_ownership_is_enforced(client, db, llm):
    other_session = db.create_chat_session(OTHER_USER_ID, "theirs")

    assert client.post("/api/chat/query/stream", json={"message": "x", "session_id": other_session}).status_code == 404
    assert client.post("/api/chat/query/stream", json={"message": "x", "session_id": "not-a-uuid"}).status_code == 404
    assert client.delete(f"/api/chat/sessions/{other_session}").status_code == 404


def test_requires_login(db):
    assert TestClient(app_module.app).post("/api/chat/query/stream", json={"message": "x"}).status_code == 401


def test_empty_message_rejected(client, db, llm):
    assert client.post("/api/chat/query/stream", json={"message": "   "}).status_code == 400


def test_read_section(client, db):
    response = client.get("/api/sections/BNS/103")
    assert response.status_code == 200
    assert response.json()["title"] == "Punishment for murder"
    assert response.json()["text"]
    assert client.get("/api/sections/BNS/99999").status_code == 404


def test_feedback(client, db):
    session_id = db.create_chat_session(USER_ID, "mine")
    body = {"session_id": session_id, "rating": -1, "question": "q", "answer": "a"}

    assert client.post("/api/feedback", json=body).json() == {"ok": True}
    assert db.feedback == [{**body, "user_id": USER_ID, "comment": None}]
    assert client.post("/api/feedback", json={**body, "rating": 5}).status_code == 422
