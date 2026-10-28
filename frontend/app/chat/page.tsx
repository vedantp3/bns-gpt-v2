"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch, apiStream } from "@/lib/api";

type User = {
  id: string;
  name: string;
  email: string;
  avatar_url: string;
};

type SessionItem = {
  id: string;
  title: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Retrieval = {
  act: string;
  section: string;
  title: string;
  chapter: string;
  text?: string;
};

type SectionPanel = {
  item: Retrieval;
  loading: boolean;
  error?: string;
};

type StreamEvent =
  | { type: "meta"; session_id: string; session_title: string | null; retrievals: Retrieval[] }
  | { type: "delta"; content: string }
  | { type: "done" }
  | { type: "error"; detail: string };

type VoiceState = "idle" | "recording" | "processing" | "speaking";

const corpusOptions = ["All Acts", "BNS", "BNSS", "BSA"];

/* Answer languages and the matching speech locale for voice input and read-aloud. */
const languageOptions: { label: string; locale: string }[] = [
  { label: "English", locale: "en-IN" },
  { label: "Hindi", locale: "hi-IN" },
  { label: "Marathi", locale: "mr-IN" },
  { label: "Tamil", locale: "ta-IN" },
  { label: "Telugu", locale: "te-IN" },
  { label: "Bengali", locale: "bn-IN" },
  { label: "Gujarati", locale: "gu-IN" },
  { label: "Kannada", locale: "kn-IN" }
];
const LANGUAGE_STORAGE_KEY = "bns-answer-language";
const STOPPED_NOTE = "\n\n_Generation stopped._";

/* Starter questions on the empty state; each one retrieves well from the index. */
const suggestedQuestions: { act: string; question: string }[] = [
  { act: "BNS", question: "What is the punishment for murder under BNS?" },
  { act: "BNSS", question: "When can police arrest without a warrant?" },
  { act: "BSA", question: "Is an electronic record admissible as evidence?" },
  { act: "BNSS", question: "When can bail be granted for a non-bailable offence?" }
];

const iconPaths = {
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  copy: "M9 9h10v12H9zM5 15V3h10",
  check: "M5 12l5 5L20 7",
  up: "M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 17.6 20H7",
  down: "M7 13V4H4v9zM7 13l4 8a2 2 0 0 0 3-2l-1-4h6a2 2 0 0 0 2-2.3l-1.4-7A2 2 0 0 0 17.6 4H7",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  send: "M4 12l16-8-6 16-2-6z",
  stop: "M7 7h10v10H7z",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7"
} as const;

function Icon({ name, size = 18 }: { name: keyof typeof iconPaths; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U";
}

function localeFor(language: string): string {
  return languageOptions.find((option) => option.label === language)?.locale || "en-IN";
}

/* ────────────────────────────────────────────────────────────
   SpeechRecognition cross-browser polyfill type
   ──────────────────────────────────────────────────────────── */
type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const W = window as any;
  return W.SpeechRecognition || W.webkitSpeechRecognition || null;
}

export default function ChatPage() {
  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [corpus, setCorpus] = useState("All Acts");
  const [language, setLanguage] = useState("English");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [retrievals, setRetrievals] = useState<Retrieval[]>([]);
  const [error, setError] = useState("");
  const [sectionPanel, setSectionPanel] = useState<SectionPanel | null>(null);
  const [ratings, setRatings] = useState<Record<number, 1 | -1>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /* ── Voice-to-Voice state ─────────────────────────────── */
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef("");
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const messagesPanelRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* Check browser support on mount */
  useEffect(() => {
    setVoiceSupported(!!getSpeechRecognition() && typeof window.speechSynthesis !== "undefined");
  }, []);

  /* Restore the preferred answer language */
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved && languageOptions.some((option) => option.label === saved)) setLanguage(saved);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    transcriptRef.current = "";
    recognition?.abort();
    abortRef.current?.abort();
    window.speechSynthesis?.cancel();
  }, []);

  /* Auto-scroll messages panel when messages change */
  useEffect(() => {
    if (messagesPanelRef.current) {
      messagesPanelRef.current.scrollTop = messagesPanelRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    void boot();
  }, []);

  async function boot() {
    try {
      const auth = await apiFetch<{ authenticated: boolean; user: User }>("/api/auth/session");
      setUser(auth.user);

      const sessionPayload = await apiFetch<{ sessions: SessionItem[] }>("/api/chat/sessions");
      setSessions(sessionPayload.sessions);

      if (sessionPayload.sessions[0]) {
        await loadSession(sessionPayload.sessions[0].id);
      }
    } catch {
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  function resetConversationView(nextMessages: Message[]) {
    setMessages(nextMessages);
    setRetrievals([]);
    setRatings({});
    setSectionPanel(null);
    setError("");
  }

  async function loadSession(sessionId: string) {
    const payload = await apiFetch<{ session: { id: string; messages: Message[] } }>(
      `/api/chat/sessions/${sessionId}`
    );
    setActiveSessionId(payload.session.id);
    resetConversationView(payload.session.messages);
  }

  async function handleCreateSession() {
    try {
      const payload = await apiFetch<{ session_id: string }>("/api/chat/sessions", {
        method: "POST",
        body: JSON.stringify({})
      });
      const nextSession: SessionItem = { id: payload.session_id, title: "New Legal Brief" };
      setSessions((current) => [nextSession, ...current]);
      setActiveSessionId(payload.session_id);
      resetConversationView([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new session.");
    }
  }

  async function handleDeleteSession(sessionId: string) {
    if (!window.confirm("Delete this case history permanently?")) return;

    try {
      await apiFetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
      const remainingSessions = sessions.filter((session) => session.id !== sessionId);
      setSessions(remainingSessions);

      if (activeSessionId === sessionId) {
        if (remainingSessions[0]) {
          await loadSession(remainingSessions[0].id);
        } else {
          setActiveSessionId(null);
          resetConversationView([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this case history.");
    }
  }

  function handleLanguageChange(next: string) {
    setLanguage(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }

  /* ── Core send (shared by text, voice and regenerate) ── */
  const sendMessage = useCallback(async (
    message: string,
    options: { fromVoice?: boolean; regenerate?: boolean } = {}
  ) => {
    const { fromVoice = false, regenerate = false } = options;
    if (!message.trim() || sending) return;

    /* An empty assistant message fills in as the answer streams. A regenerate
       replaces the last answer and keeps the question already on screen. */
    setMessages((current) => {
      if (!regenerate) {
        return [...current, { role: "user", content: message }, { role: "assistant", content: "" }];
      }
      const withoutAnswer = current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current;
      return [...withoutAnswer, { role: "assistant", content: "" }];
    });
    setRatings((current) => {
      const next = { ...current };
      delete next[messages.length - 1];
      return next;
    });
    if (!regenerate) setInput("");
    setSending(true);
    setError("");
    setRetrievals([]);
    if (fromVoice) setVoiceState("processing");

    const controller = new AbortController();
    abortRef.current = controller;

    let answer = "";
    const showAnswer = (content: string) => {
      setMessages((current) => [...current.slice(0, -1), { role: "assistant", content }]);
    };

    try {
      await apiStream<StreamEvent>(
        "/api/chat/query/stream",
        { message, act_filter: corpus, session_id: activeSessionId, language, regenerate },
        (event) => {
          switch (event.type) {
            case "meta":
              setActiveSessionId(event.session_id);
              setRetrievals(event.retrievals);
              setSessions((current) => {
                const title = event.session_title;
                if (!current.some((session) => session.id === event.session_id)) {
                  return [{ id: event.session_id, title: title || "New Legal Brief" }, ...current];
                }
                return title
                  ? current.map((session) => (session.id === event.session_id ? { ...session, title } : session))
                  : current;
              });
              break;
            case "delta":
              answer += event.content;
              showAnswer(answer);
              break;
            case "error":
              throw new Error(event.detail);
          }
        },
        controller.signal
      );

      if (fromVoice) {
        speakText(answer);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        /* Stopped by the user: keep what was written so far (it is not saved). */
        if (answer) {
          showAnswer(answer + STOPPED_NOTE);
        } else {
          setMessages((current) => current.slice(0, -1));
        }
        if (fromVoice) setVoiceState("idle");
        return;
      }

      setMessages((current) => current.slice(0, regenerate ? -1 : -2));
      if (!regenerate) setInput(message);
      setError(err instanceof Error ? err.message : "Query could not be analyzed.");
      if (fromVoice) setVoiceState("idle");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }, [sending, corpus, activeSessionId, language, messages.length]);

  async function handleSend() {
    await sendMessage(input.trim());
  }

  function stopGenerating() {
    abortRef.current?.abort();
  }

  function lastQuestion(): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return null;
  }

  function handleRegenerate() {
    const question = lastQuestion();
    if (question) void sendMessage(question, { regenerate: true });
  }

  /* ── Answer actions ─────────────────────────────────── */
  async function copyAnswer(index: number) {
    try {
      await navigator.clipboard.writeText(messages[index].content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  }

  async function rateAnswer(index: number, rating: 1 | -1) {
    if (!activeSessionId || ratings[index] === rating) return;
    const question = messages[index - 1]?.role === "user" ? messages[index - 1].content : "";

    setRatings((current) => ({ ...current, [index]: rating }));
    try {
      await apiFetch("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          session_id: activeSessionId,
          rating,
          question,
          answer: messages[index].content
        })
      });
    } catch (err) {
      setRatings((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
      setError(err instanceof Error ? err.message : "Could not save your feedback.");
    }
  }

  function downloadBrief() {
    const title = sessions.find((session) => session.id === activeSessionId)?.title || "Legal Brief";
    const body = messages
      .map((message) => `## ${message.role === "user" ? "Question" : "Answer"}\n\n${message.content}`)
      .join("\n\n");
    const markdown = `# ${title}\n\n_Exported ${new Date().toLocaleString()} from BNS Legal Intelligence Desk._\n\n${body}\n`;

    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "legal-brief"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /* ── Citation panel ─────────────────────────────────── */
  async function openSection(item: Retrieval) {
    setSectionPanel({ item, loading: true });
    try {
      const section = await apiFetch<Retrieval>(
        `/api/sections/${encodeURIComponent(item.act)}/${encodeURIComponent(item.section)}`
      );
      setSectionPanel((current) => (current?.item === item ? { item: section, loading: false } : current));
    } catch (err) {
      setSectionPanel((current) =>
        current?.item === item
          ? { item, loading: false, error: err instanceof Error ? err.message : "Could not load this section." }
          : current
      );
    }
  }

  /* ── Text-to-Speech ────────────────────────────────── */
  function speakText(text: string) {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setVoiceState("idle");
      return;
    }

    window.speechSynthesis.cancel();

    const summarySection = text.match(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Short Answer|Plain Language Explanation|Brief Summary)(?:\*\*)?\s*:?\s*\n+([\s\S]*?)(?=\n\s*(?:#{1,6}\s|\*\*[^*]+\*\*)|$)/i
    );

    /* Speak only the brief answer, not the full formatted legal brief. */
    const cleanText = (summarySection?.[1] || text)
      .replace(/#{1,6}\s*/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/>\s*/g, "")
      .replace(/[-•]\s*/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim();

    const locale = localeFor(language);
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = locale;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    /* Try to select a good voice for the answer language */
    const voices = window.speechSynthesis.getVoices();
    const languageCode = locale.split("-")[0];
    const inLanguage = voices.filter((v) => v.lang.startsWith(languageCode));
    const preferred =
      inLanguage.find((v) => {
        const name = v.name.toLowerCase();
        return name.includes("google") || name.includes("natural") || name.includes("neural");
      }) ||
      inLanguage.find((v) => v.lang === locale) ||
      inLanguage[0];

    if (preferred) utterance.voice = preferred;

    utterance.onstart = () => {
      if (utteranceRef.current === utterance) setVoiceState("speaking");
    };
    utterance.onend = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setVoiceState("idle");
    };
    utterance.onerror = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setVoiceState("idle");
    };

    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setVoiceState("speaking");
  }

  function stopSpeaking() {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    utteranceRef.current = null;
    setVoiceState("idle");
  }

  /* ── Speech-to-Text (recording) ────────────────────── */
  function startRecording() {
    const SRCtor = getSpeechRecognition();
    if (!SRCtor) {
      setError("Voice input is not supported in this browser. Try Chrome or Edge.");
      return;
    }

    setError("");
    setLiveTranscript("");
    transcriptRef.current = "";

    const recognition = new SRCtor();
    let recognitionFailed = false;
    recognition.lang = localeFor(language);
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript + " ";
        } else {
          interim += transcript;
        }
      }
      transcriptRef.current = (final + interim).trim();
      setLiveTranscript(transcriptRef.current);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== "aborted") {
        setError(`Voice recognition error: ${event.error}`);
        recognitionFailed = true;
      }
      transcriptRef.current = "";
      setLiveTranscript("");
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;

      const transcript = transcriptRef.current.trim();
      transcriptRef.current = "";
      setLiveTranscript("");

      if (!recognitionFailed && transcript) {
        void sendMessage(transcript, { fromVoice: true });
      } else {
        setVoiceState("idle");
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setVoiceState("recording");
    } catch {
      recognitionRef.current = null;
      setVoiceState("idle");
      setError("Could not start voice recognition. Check microphone access and try again.");
    }
  }

  function stopRecording() {
    if (!recognitionRef.current) return;
    setVoiceState("processing");
    recognitionRef.current.stop();
  }

  function toggleVoice() {
    if (voiceState === "recording") {
      stopRecording();
    } else if (voiceState === "speaking") {
      stopSpeaking();
    } else if (voiceState === "idle") {
      startRecording();
    }
    /* Do nothing if "processing" — just wait */
  }

  async function handleLogout() {
    await apiFetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  /* ── Voice state label & icon helper ────────────────── */
  function getVoiceLabel(): string {
    switch (voiceState) {
      case "recording":
        return "Listening…";
      case "processing":
        return "Analyzing…";
      case "speaking":
        return "AI Speaking…";
      default:
        return "Voice Input";
    }
  }

  if (loading) {
    return (
      <main className="loading-shell">
        <img src="/images/scales.svg" alt="" width={56} height={56} className="loading-mark" />
        <span>Opening your legal workspace…</span>
      </main>
    );
  }

  const lastAssistantIndex = messages[messages.length - 1]?.role === "assistant" ? messages.length - 1 : -1;
  const canRegenerate = !sending && lastQuestion() !== null && messages.length > 0;
  const activeTitle = sessions.find((session) => session.id === activeSessionId)?.title || "New Legal Brief";

  return (
    <main className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────── */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Case history">
        <div className="sidebar-brand">
          <img src="/images/scales.svg" alt="" width={40} height={40} />
          <div>
            <strong>BNS Legal Desk</strong>
            <span>BNS · BNSS · BSA</span>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            type="button"
            aria-label="Close menu"
          >
            <Icon name="close" />
          </button>
        </div>

        <button
          className="new-brief-button"
          onClick={() => {
            setSidebarOpen(false);
            void handleCreateSession();
          }}
          type="button"
          disabled={sending}
        >
          <Icon name="plus" />
          New Legal Brief
        </button>

        <div className="sidebar-label">Case history</div>
        <nav className="session-list">
          {sessions.length === 0 ? <p className="session-empty">Your briefs will appear here.</p> : null}
          {sessions.map((session) => (
            <div className={`session-row ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
              <button
                className="session-item"
                onClick={() => {
                  setSidebarOpen(false);
                  void loadSession(session.id);
                }}
                type="button"
                disabled={sending}
                title={session.title}
              >
                <Icon name="book" size={15} />
                <span>{session.title}</span>
              </button>
              <button
                aria-label={`Delete ${session.title}`}
                className="session-delete"
                onClick={() => void handleDeleteSession(session.id)}
                title="Delete case history"
                type="button"
                disabled={sending}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </nav>

        {user ? (
          <div className="profile-card">
            <div className="profile-avatar" aria-hidden="true">{initials(user.name)}</div>
            <div className="profile-text">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <button className="icon-button" onClick={handleLogout} type="button" aria-label="Sign out" title="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        ) : null}
      </aside>
      {sidebarOpen ? <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} role="presentation" /> : null}

      {/* ── Workspace ───────────────────────────────────── */}
      <section className="workspace">
        <header className="appbar">
          <button
            className="icon-button menu-button"
            onClick={() => setSidebarOpen(true)}
            type="button"
            aria-label="Open case history"
          >
            <Icon name="menu" />
          </button>
          <div className="appbar-title">
            <span className="kicker">Legal brief</span>
            <h1>{activeTitle}</h1>
          </div>
          <div className="appbar-controls">
            <label className="select-pill">
              <span>Corpus</span>
              <select value={corpus} onChange={(e) => setCorpus(e.target.value)} aria-label="Target legal corpus">
                {corpusOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="select-pill">
              <span>Language</span>
              <select value={language} onChange={(e) => handleLanguageChange(e.target.value)} aria-label="Answer language">
                {languageOptions.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {messages.length > 0 ? (
              <>
                <button
                  className="icon-button"
                  onClick={downloadBrief}
                  type="button"
                  disabled={sending}
                  aria-label="Download brief as Markdown"
                  title="Download brief (.md)"
                >
                  <Icon name="download" />
                </button>
                <button
                  className="icon-button"
                  onClick={() => window.print()}
                  type="button"
                  disabled={sending}
                  aria-label="Print or save as PDF"
                  title="Print / Save as PDF"
                >
                  <Icon name="print" />
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="messages-scroll" ref={messagesPanelRef}>
          <div className="messages-column">
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-hero">
                  <div className="welcome-hero-copy">
                    <span className="kicker light">Indian criminal law research</span>
                    <h2>Ask like an investigator. Read like a legal researcher.</h2>
                    <p>
                      Answers grounded in the text of the Bharatiya Nyaya Sanhita, Bharatiya Nagarik
                      Suraksha Sanhita and Bharatiya Sakshya Adhiniyam — with the sections they rely on.
                    </p>
                  </div>
                </div>

                <div className="act-strip">
                  <div>
                    <strong>BNS</strong>
                    <span>Offences &amp; punishments</span>
                  </div>
                  <div>
                    <strong>BNSS</strong>
                    <span>Arrest, bail &amp; procedure</span>
                  </div>
                  <div>
                    <strong>BSA</strong>
                    <span>Evidence &amp; proof</span>
                  </div>
                </div>

                <div className="suggestion-label">Try asking</div>
                <div className="suggestion-grid">
                  {suggestedQuestions.map((item) => (
                    <button
                      key={item.question}
                      className="suggestion-card"
                      onClick={() => void sendMessage(item.question)}
                      type="button"
                    >
                      <span className="act-badge">{item.act}</span>
                      {item.question}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, index) => {
                const isAssistant = message.role === "assistant";
                const isStreaming = sending && index === messages.length - 1 && isAssistant;
                const showSources = isAssistant && index === lastAssistantIndex && retrievals.length > 0;

                if (!isAssistant) {
                  return (
                    <article key={`user-${index}`} className="message-row user">
                      <div className="user-bubble">{message.content}</div>
                    </article>
                  );
                }

                return (
                  <article key={`assistant-${index}`} className="message-row assistant">
                    <div className="assistant-avatar" aria-hidden="true">
                      <img src="/images/scales.svg" alt="" width={22} height={22} />
                    </div>
                    <div className="assistant-card">
                      <div className="assistant-label">Legal AI</div>
                      {!message.content ? (
                        <div className="typing" aria-label="Searching statutes and drafting answer">
                          <span /><span /><span />
                          <em>Searching statutes and drafting answer…</em>
                        </div>
                      ) : (
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                          {isStreaming ? <span className="stream-caret" aria-hidden="true" /> : null}
                        </div>
                      )}

                      {showSources ? (
                        <div className="sources">
                          <div className="sources-label">Sources · click to read the section</div>
                          <div className="sources-list">
                            {retrievals.map((item, sourceIndex) => (
                              <button
                                key={`${item.act}-${item.section}-${sourceIndex}`}
                                className="source-chip"
                                onClick={() => void openSection(item)}
                                type="button"
                                title={item.chapter}
                              >
                                <span className="act-badge">{item.act} §{item.section}</span>
                                <span className="source-title">{item.title}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {message.content && !isStreaming ? (
                        <div className="message-actions">
                          <button
                            className="action-button"
                            onClick={() => void copyAnswer(index)}
                            type="button"
                            aria-label="Copy answer"
                            title="Copy"
                          >
                            <Icon name={copiedIndex === index ? "check" : "copy"} size={16} />
                            {copiedIndex === index ? "Copied" : "Copy"}
                          </button>
                          <button
                            className={`action-button ${ratings[index] === 1 ? "selected" : ""}`}
                            onClick={() => void rateAnswer(index, 1)}
                            type="button"
                            aria-label="Helpful answer"
                            title="Helpful"
                            disabled={!activeSessionId}
                          >
                            <Icon name="up" size={16} />
                          </button>
                          <button
                            className={`action-button ${ratings[index] === -1 ? "selected" : ""}`}
                            onClick={() => void rateAnswer(index, -1)}
                            type="button"
                            aria-label="Unhelpful answer"
                            title="Not helpful"
                            disabled={!activeSessionId}
                          >
                            <Icon name="down" size={16} />
                          </button>
                          {index === lastAssistantIndex && canRegenerate ? (
                            <button className="action-button" onClick={handleRegenerate} type="button">
                              <Icon name="refresh" size={16} />
                              Regenerate
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}

            {canRegenerate && messages[messages.length - 1]?.role === "user" ? (
              <div className="retry-row">
                <button className="action-button" onClick={handleRegenerate} type="button">
                  <Icon name="refresh" size={16} />
                  No answer yet — retry this question
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Composer ────────────────────────────────── */}
        <footer className="composer-dock">
          <div className="composer-column">
            {error ? <div className="error-banner">{error}</div> : null}

            {voiceState === "recording" && liveTranscript ? (
              <div className="voice-transcript-banner">
                <div className="voice-transcript-label">
                  <span className="voice-pulse-dot" />
                  Live transcription
                </div>
                <div className="voice-transcript-text">{liveTranscript}</div>
              </div>
            ) : null}

            {voiceState === "processing" ? (
              <div className="voice-status-banner processing">
                <svg className="voice-spinner" width="20" height="20" viewBox="0 0 20 20">
                  <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="36 14" strokeLinecap="round" />
                </svg>
                Analyzing your voice query…
              </div>
            ) : null}

            {voiceState === "speaking" ? (
              <div className="voice-status-banner speaking">
                <div className="voice-wave-bars">
                  <span /><span /><span /><span /><span />
                </div>
                Reading the short answer aloud
                <button className="voice-stop-btn" onClick={stopSpeaking} type="button" title="Stop speaking">
                  <Icon name="stop" size={14} />
                  Stop
                </button>
              </div>
            ) : null}

            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Ask about an offence, a section number, arrest, bail or evidence…"
                aria-label="Your legal question"
                rows={2}
              />
              <div className="composer-actions">
                <button
                  className={`voice-button ${voiceState}`}
                  onClick={toggleVoice}
                  type="button"
                  disabled={!voiceSupported || voiceState === "processing" || sending}
                  title={voiceSupported ? getVoiceLabel() : "Voice chat is not supported in this browser."}
                  aria-label={voiceSupported ? getVoiceLabel() : "Voice chat is not supported in this browser"}
                >
                  {voiceState === "recording" || voiceState === "speaking" ? (
                    <Icon name="stop" size={20} />
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="8" y="2" width="6" height="12" rx="3" />
                      <path d="M4 10a7 7 0 0 0 14 0" />
                      <line x1="11" y1="17" x2="11" y2="20" />
                      <line x1="8" y1="20" x2="14" y2="20" />
                    </svg>
                  )}
                  {voiceState === "recording" ? <span className="voice-ring" /> : null}
                </button>
                {sending ? (
                  <button className="send-button stop-button" onClick={stopGenerating} type="button" aria-label="Stop generating">
                    <Icon name="stop" size={18} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    className="send-button"
                    onClick={() => void handleSend()}
                    type="button"
                    disabled={!input.trim()}
                    aria-label="Send question"
                  >
                    <Icon name="send" size={18} />
                    <span>Ask</span>
                  </button>
                )}
              </div>
            </div>
            <p className="composer-note">
              AI-generated legal information, not legal advice. Verify against the official text of the Act.
              {!voiceSupported ? " Voice input needs Chrome or Edge." : ""}
            </p>
          </div>
        </footer>
      </section>

      {/* ── Citation panel ─────────────────────────────── */}
      {sectionPanel ? (
        <div className="section-overlay" onClick={() => setSectionPanel(null)} role="presentation">
          <aside
            className="section-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`${sectionPanel.item.act} Section ${sectionPanel.item.section}`}
          >
            <div className="section-drawer-head">
              <div>
                <span className="act-badge">{sectionPanel.item.act} §{sectionPanel.item.section}</span>
                <h2>{sectionPanel.item.title}</h2>
                <p>{sectionPanel.item.chapter}</p>
              </div>
              <button className="icon-button" onClick={() => setSectionPanel(null)} type="button" aria-label="Close">
                <Icon name="close" />
              </button>
            </div>
            {sectionPanel.loading ? (
              <p className="message-pending">Loading statutory text…</p>
            ) : sectionPanel.error ? (
              <div className="error-banner">{sectionPanel.error}</div>
            ) : (
              <div className="section-drawer-text">
                {/* The dataset prefixes each section with a "[Context: …]" line meant for search. */}
                {sectionPanel.item.text?.replace(/^\s*\[Context:[^\]]*\]\s*/, "")}
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </main>
  );
}
