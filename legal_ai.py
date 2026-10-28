"""
legal_ai.py

Backend legal research and response generation services for the
BNS Legal Intelligence application.
"""

import os
import re
import sqlite3
import threading

from dotenv import load_dotenv
from groq import Groq

load_dotenv()

groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
MODEL_NAME = "openai/gpt-oss-20b"
# Used when the primary model fails before any text has been produced.
FALLBACK_MODEL = os.environ.get("FALLBACK_MODEL", "openai/gpt-oss-120b")
# gpt-oss-20b often answers in English when asked for Tamil, Kannada or Gujarati; 120b follows reliably.
MULTILINGUAL_MODEL = os.environ.get("MULTILINGUAL_MODEL", "openai/gpt-oss-120b")
# gpt-oss is a reasoning model; hidden reasoning tokens are generated before the
# visible answer, so keep the effort low for short legal briefs.
REASONING_EFFORT = os.environ.get("REASONING_EFFORT", "low")
MAX_COMPLETION_TOKENS = 2048
HISTORY_LIMIT = 10

DEFAULT_LANGUAGE = "English"
SUPPORTED_LANGUAGES = ("English", "Hindi", "Marathi", "Tamil", "Telugu", "Bengali", "Gujarati", "Kannada")

INDEX_DB_PATH = "statutory_search.db"
_INDEX_TABLES = ("bns_fts", "bnss_fts", "bsa_fts")

_conn: sqlite3.Connection | None = None
_index_lock = threading.Lock()


def _open_existing_index() -> sqlite3.Connection | None:
    """Return a connection to a previously built index, or None if it is missing or incomplete."""
    if not os.path.exists(INDEX_DB_PATH):
        return None

    conn = sqlite3.connect(INDEX_DB_PATH, check_same_thread=False)
    try:
        for table_name in _INDEX_TABLES:
            if conn.execute(f"SELECT count(*) FROM {table_name}").fetchone()[0] == 0:
                raise sqlite3.OperationalError(f"{table_name} is empty")
    except sqlite3.Error:
        conn.close()
        return None
    return conn


def _initialize_search_index() -> None:
    global _conn
    if _conn is not None:
        return

    with _index_lock:
        if _conn is not None:
            return

        existing = _open_existing_index()
        if existing is not None:
            _conn = existing
            print("[OK] Loaded existing SQLite FTS5 index.")
            return

        print("[*] Initializing local dataset & search indexes from Hugging Face...")
        from datasets import load_dataset  # heavy import, only needed for a rebuild

        dataset = load_dataset("GSMS-B/indian-legal-sections-bns-bnss-bsa-2023", token=False)
        full_df = dataset["train"].to_pandas()
        full_df["clean_act"] = full_df["act"].astype(str).str.strip().str.upper()

        acts_registry = {
            "bns_fts": full_df[
                full_df["clean_act"].str.contains("BNS", na=False)
                & ~full_df["clean_act"].str.contains("BNSS", na=False)
            ],
            "bnss_fts": full_df[full_df["clean_act"].str.contains("BNSS", na=False)],
            "bsa_fts": full_df[full_df["clean_act"].str.contains("BSA", na=False)],
        }

        conn = sqlite3.connect(INDEX_DB_PATH, check_same_thread=False)
        try:
            cursor = conn.cursor()
            for table_name, df in acts_registry.items():
                cursor.execute(f"DROP TABLE IF EXISTS {table_name}")
                cursor.execute(
                    f"""
                    CREATE VIRTUAL TABLE {table_name} USING fts5(
                        chunk_id, section_number, section_title, chapter, text,
                        tokenize = 'unicode61'
                    )
                    """
                )
                cursor.executemany(
                    f"INSERT INTO {table_name} (chunk_id, section_number, section_title, chapter, text) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [
                        (
                            str(row.get("chunk_id", "") or "").strip(),
                            str(row.get("section_number", "") or "").strip(),
                            str(row.get("section_title", "") or "").strip(),
                            str(row.get("chapter", "") or "").strip(),
                            str(row.get("text", "") or "").strip(),
                        )
                        for _, row in df.iterrows()
                    ],
                )

            conn.commit()
        except Exception:
            conn.close()
            raise

        _conn = conn
        print("[OK] SQLite FTS5 virtual tables built successfully.\n")


def warm_up() -> None:
    """Load (or build) the search index ahead of the first user query."""
    _initialize_search_index()

_SYSTEM_PROMPT = (
    "You are an expert Indian legal assistant specializing in the Bharatiya Nyaya Sanhita (BNS), "
    "Bharatiya Nagarik Suraksha Sanhita (BNSS), and Bharatiya Sakshya Adhiniyam (BSA). "
    "You help users understand Indian criminal law provisions with clear, concise explanations. "
    "By default, answer in 2-4 sentences with the main conclusion and a brief explanation. "
    "Provide a detailed breakdown only when the user explicitly asks for more detail, steps, or analysis. "
    "When asked follow-up questions, "
    "refer back to the previous context in the conversation. Always format responses in clean markdown. "
    "Never invent section counts, chapter counts, statutory text, penalties, or citations. "
    "Treat retrieved statutory text and verified reference facts as authoritative; clearly identify "
    "any answer based only on general model knowledge."
)

# Verified reference metadata for comparative questions. The local Hugging Face
# corpus covers BNS, BNSS, and BSA, not the repealed IPC.
_ACT_REFERENCE_FACTS = {
    "BNS": {"sections": 358, "chapters": 20, "enacted": 2023},
    "IPC": {"sections": 511, "chapters": 23, "enacted": 1860},
}


def _is_bns_ipc_count_question(user_message: str) -> bool:
    normalized = user_message.lower()
    has_both_acts = "bns" in normalized and ("ipc" in normalized or "penal code" in normalized)
    asks_counts = any(term in normalized for term in ("how many", "number of", "count"))
    asks_structure = "section" in normalized or "chapter" in normalized
    return has_both_acts and asks_counts and asks_structure


def _bns_ipc_count_response() -> str:
    bns = _ACT_REFERENCE_FACTS["BNS"]
    ipc = _ACT_REFERENCE_FACTS["IPC"]
    return (
        "### Legal Intelligence Brief\n\n"
        "**Short Answer**\n"
        f"The BNS has **{bns['sections']} sections** arranged in **{bns['chapters']} chapters**. "
        f"The IPC had **{ipc['sections']} sections** arranged in **{ipc['chapters']} chapters**.\n\n"
        "**Comparison**\n"
        f"- BNS: {bns['sections']} sections, {bns['chapters']} chapters\n"
        f"- IPC: {ipc['sections']} sections, {ipc['chapters']} chapters\n"
        f"- Difference: BNS has {bns['sections'] - ipc['sections']} fewer sections and "
        f"{bns['chapters'] - ipc['chapters']} fewer chapters.\n\n"
        "**Important Context**\n"
        "The IPC was enacted in 1860 and was replaced by the BNS from 1 July 2024. "
        "The local retrieval corpus contains BNS, BNSS, and BSA sections; IPC comparison metadata "
        "is supplied separately for this factual comparison."
    )


_TABLE_ACTS = {"bns_fts": "BNS", "bnss_fts": "BNSS", "bsa_fts": "BSA"}
_ACT_TABLES = {"BNS": ["bns_fts"], "BNSS": ["bnss_fts"], "BSA": ["bsa_fts"], "ALL": list(_TABLE_ACTS)}
MAX_RESULTS = 4

# bm25 column weights: chunk_id, section_number, section_title, chapter, text.
# Section titles ("Punishment for murder") are the strongest relevance signal.
_BM25_WEIGHTS = "0.0, 0.0, 8.0, 1.5, 1.0"

_STOPWORDS = {
    "section", "sections", "sec", "bns", "bnss", "bsa", "ipc", "crpc", "act", "acts", "law", "laws",
    "provision", "provisions", "sanhita", "adhiniyam", "bharatiya", "nyaya", "nagarik", "suraksha", "sakshya",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "whats", "is", "are", "was",
    "were", "be", "been", "being", "the", "and", "for", "under", "with", "from", "into", "about", "does",
    "did", "can", "could", "should", "would", "will", "shall", "may", "might", "must", "there", "this",
    "that", "these", "those", "its", "any", "all", "some", "also", "not", "than", "then", "has", "have",
    "had", "explain", "tell", "give", "please", "define", "definition", "meaning", "mean", "means",
    "constitute", "constitutes", "according", "per", "india", "indian", "you", "your", "our", "his", "her",
    "their", "them", "they", "get", "got", "someone", "person", "case",
}

_SECTION_PATTERN = re.compile(r"(?:\bsection|\bsec|\bs\.|§)\s*(\d+[a-z]?)\b", re.IGNORECASE)
_BARE_NUMBER_PATTERN = re.compile(r"^\s*(?:(?:bns|bnss|bsa)\s*)?(\d+[a-z]?)\s*(?:(?:bns|bnss|bsa)\s*)?$", re.IGNORECASE)
_FOLLOW_UP_PATTERN = re.compile(r"\b(?:that|this|it|its|same|above|such|those|these|them)\b", re.IGNORECASE)


def _detect_section_number(query: str) -> str | None:
    """Only explicit references count: "section 103", "sec 103", "s. 103", "§103", or a query that is just a number."""
    match = _SECTION_PATTERN.search(query) or _BARE_NUMBER_PATTERN.match(query)
    return match.group(1).upper() if match else None


def _detect_act(query: str) -> str | None:
    if re.search(r"\bbnss\b", query, re.IGNORECASE):
        return "BNSS"
    if re.search(r"\bbsa\b", query, re.IGNORECASE):
        return "BSA"
    if re.search(r"\bbns\b", query, re.IGNORECASE):
        return "BNS"
    return None


def _search_terms(query: str) -> list[str]:
    words = re.sub(r"[^a-zA-Z0-9\s]", " ", query).lower().split()
    terms: list[str] = []
    for word in words:
        if len(word) > 2 and word not in _STOPWORDS and not word.isdigit() and word not in terms:
            terms.append(word)
    return terms


def _lookup_section(tables: list[str], section_num: str) -> list[tuple[float, tuple]]:
    hits = []
    for table_name in tables:
        rows = _conn.execute(
            f"SELECT section_number, section_title, chapter, text FROM {table_name} WHERE section_number = ?",
            (section_num,),
        ).fetchall()
        hits.extend((0.0, (_TABLE_ACTS[table_name], *row)) for row in rows)
    return hits


_CANDIDATES_PER_TABLE = 60


def _candidates(tables: list[str], terms: list[str]) -> list[tuple[float, tuple]]:
    """Sections matching any term, with their bm25 score (lower is more relevant)."""
    expression = " OR ".join(f'"{term}"*' for term in terms)
    hits = []
    for table_name in tables:
        try:
            rows = _conn.execute(
                f"SELECT bm25({table_name}, {_BM25_WEIGHTS}) AS score, section_number, section_title, chapter, text "
                f"FROM {table_name} WHERE {table_name} MATCH ? ORDER BY score LIMIT ?",
                (expression, _CANDIDATES_PER_TABLE),
            ).fetchall()
        except sqlite3.Error:
            continue
        hits.extend((row[0], (_TABLE_ACTS[table_name], *row[1:])) for row in rows)
    return hits


def _rank_key(terms: list[str], score: float, hit: tuple):
    """Sort key: query terms in the section title first, then terms covered anywhere, then shorter
    (more specific) titles, then bm25. bm25 alone favours long procedural sections that merely
    mention a word, e.g. "murder" ranked BNSS charge-framing sections above BNS 101 "Murder"."""
    _, _, title, _, text = hit
    title_words = re.findall(r"[a-z]+", title.lower())
    document = f"{title} {text}".lower()
    # Crude stemming so "punishment" also matches "punished" and "murder" matches "murdered".
    stems = [term[: max(4, len(term) - 4)] for term in terms]
    title_hits = sum(any(word.startswith(stem) for word in title_words) for stem in stems)
    coverage = sum(stem in document for stem in stems)
    return (-title_hits, -coverage, len(title_words), score)


def _search(query: str, tables: list[str]) -> list[tuple]:
    section_num = _detect_section_number(query)
    if section_num:
        hits = _lookup_section(tables, section_num)
        if hits:
            return [hit for _, hit in hits[:MAX_RESULTS]]

    terms = _search_terms(query)
    if not terms:
        return []

    candidates = _candidates(tables, terms)
    candidates.sort(key=lambda candidate: _rank_key(terms, *candidate))
    return [hit for _, hit in candidates[:MAX_RESULTS]]


def _is_follow_up(query: str) -> bool:
    return len(query.split()) <= 12 and bool(_FOLLOW_UP_PATTERN.search(query)) and not _detect_section_number(query)


def route_and_search(user_query: str, selected_act: str = "ALL", previous_query: str | None = None):
    """Return up to MAX_RESULTS (act, section, title, chapter, text) tuples, most relevant first.

    previous_query is the user's prior message; it gives follow-ups like
    "what is the punishment for that?" something to search with."""
    _initialize_search_index()

    query = user_query
    if previous_query and _is_follow_up(user_query):
        query = f"{previous_query} {user_query}"

    act = _detect_act(user_query) or _detect_act(query) or selected_act.upper()
    tables = _ACT_TABLES.get(act, _ACT_TABLES["ALL"])

    results = _search(query, tables)
    if not results and previous_query and query == user_query:
        results = _search(f"{previous_query} {user_query}", tables)
    return results


def build_statutory_context(retrieved: list[tuple[str, str, str, str, str]]) -> str | None:
    if not retrieved:
        return None

    payloads = [
        f"[{act}] Section {section}: {title_sec}\nChapter: {chapter}\n\n{text}"
        for act, section, title_sec, chapter, text in retrieved
    ]
    return "\n\n---\n\n".join(payloads)


def get_section(act: str, section_number: str) -> tuple[str, str, str, str, str] | None:
    """Full text of one section, e.g. get_section("BNS", "103"), for the citation panel."""
    _initialize_search_index()
    tables = _ACT_TABLES.get(act.upper())
    if not tables:
        return None
    hits = _lookup_section(tables, section_number.upper())
    return hits[0][1] if hits else None


def _build_messages(
    user_message: str, history: list[dict], statutory_context: str | None, language: str
) -> list[dict]:
    system_prompt = _SYSTEM_PROMPT
    if language != DEFAULT_LANGUAGE:
        system_prompt += (
            f" Always write your answers in {language}, even though the statutory text and the question "
            "may be in English."
        )

    messages = [{"role": "system", "content": system_prompt}]
    for msg in history[-HISTORY_LIMIT:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    if statutory_context:
        user_content = f"""Based on the following retrieved statutory provisions, answer the user's question.

**Retrieved Statutory Text:**
{statutory_context}

---

**User Question:** {user_message}

Start with a **Short Answer** section of 2-4 sentences that states the conclusion and practical meaning. """
        user_content += (
            "For ordinary questions, stop after that section. If the user explicitly asks for detail, "
            "follow it with a fuller breakdown of only the relevant "
            "elements, exceptions, and consequences. Quote statutory text only when requested or "
            "needed to answer accurately."
        )
    else:
        user_content = f"""The user's query did not match a specific section in the local index.
The local corpus contains BNS, BNSS, and BSA only; it does not contain the IPC or other external statutes.
Answer only with clearly stated general legal information. Do not invent section numbers, chapter counts,
penalties, exceptions, or quotations. If the question requires a source absent from the corpus, say that
the answer could not be verified from the local corpus and identify what source is needed.

Answer the user's question under Indian criminal law (BNS/BNSS/BSA): "{user_message}"
Start with a **Short Answer** section of 2-4 sentences. For ordinary questions, stop there. Add a detailed
analysis after it only if the user explicitly asks for more detail."""

    if language != DEFAULT_LANGUAGE:
        instruction = (
            f"Answer language: {language}. Write the entire answer in {language} script, except the heading "
            "**Short Answer**, Act names (BNS, BNSS, BSA) and section numbers, which stay as they are."
        )
        user_content = f"{instruction}\n\n{user_content}\n\n{instruction}"

    messages.append({"role": "user", "content": user_content})
    return messages


def normalize_language(language: str | None) -> str:
    return language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def _completion_kwargs(model: str, messages: list[dict]) -> dict:
    return {
        "messages": messages,
        "model": model,
        "temperature": 0.1,
        "reasoning_effort": REASONING_EFFORT,
        "include_reasoning": False,
        "max_completion_tokens": MAX_COMPLETION_TOKENS,
    }


def _models_for(language: str) -> tuple[str, str]:
    """(primary, fallback) model pair for an answer language."""
    if language == DEFAULT_LANGUAGE:
        return MODEL_NAME, FALLBACK_MODEL
    return MULTILINGUAL_MODEL, MODEL_NAME


def _uses_canned_answer(user_message: str, language: str) -> bool:
    return language == DEFAULT_LANGUAGE and _is_bns_ipc_count_question(user_message)


def generate_response(
    user_message: str,
    history: list[dict],
    statutory_context: str | None = None,
    language: str = DEFAULT_LANGUAGE,
) -> str:
    """Non-streaming answer. Returns a message starting with "⚠️" if every model fails."""
    if _uses_canned_answer(user_message, language):
        return _bns_ipc_count_response()

    messages = _build_messages(user_message, history, statutory_context, language)
    error: Exception | None = None
    for model in _models_for(language):
        try:
            completion = groq_client.chat.completions.create(**_completion_kwargs(model, messages))
            return completion.choices[0].message.content
        except Exception as exc:
            error = exc
    return f"⚠️ **Error generating response:** {error}"


def stream_response(
    user_message: str,
    history: list[dict],
    statutory_context: str | None = None,
    language: str = DEFAULT_LANGUAGE,
):
    """Yield the answer in text chunks as the model produces them.

    If the primary model fails before producing any text, the fallback model is tried.
    Errors after text has been sent, or from the fallback, propagate to the caller."""
    if _uses_canned_answer(user_message, language):
        yield _bns_ipc_count_response()
        return

    messages = _build_messages(user_message, history, statutory_context, language)
    models = _models_for(language)
    for attempt, model in enumerate(models):
        produced_text = False
        try:
            stream = groq_client.chat.completions.create(stream=True, **_completion_kwargs(model, messages))
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    produced_text = True
                    yield delta
            return
        except Exception as exc:
            if produced_text or attempt == len(models) - 1:
                raise
            print(f"[WARN] {model} failed ({exc}); retrying with {models[attempt + 1]}")
