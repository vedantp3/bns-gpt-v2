"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { API_BASE_URL, apiFetch } from "@/lib/api";

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
  text: string;
};

type VoiceState = "idle" | "recording" | "processing" | "speaking";

const corpusOptions = ["All Acts", "BNS", "BNSS", "BSA"];

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
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [retrievals, setRetrievals] = useState<Retrieval[]>([]);
  const [error, setError] = useState("");

  /* ── Voice-to-Voice state ─────────────────────────────── */
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef("");
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const messagesPanelRef = useRef<HTMLDivElement | null>(null);

  /* Check browser support on mount */
  useEffect(() => {
    setVoiceSupported(!!getSpeechRecognition() && typeof window.speechSynthesis !== "undefined");
  }, []);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    transcriptRef.current = "";
    recognition?.abort();
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

  async function loadSession(sessionId: string) {
    const payload = await apiFetch<{ session: { id: string; messages: Message[] } }>(
      `/api/chat/sessions/${sessionId}`
    );
    setActiveSessionId(payload.session.id);
    setMessages(payload.session.messages);
    setRetrievals([]);
    setError("");
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
      setMessages([]);
      setRetrievals([]);
      setError("");
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
          setMessages([]);
          setRetrievals([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this case history.");
    }
  }

  /* ── Core send (shared by text + voice) ─────────────── */
  const sendMessage = useCallback(async (message: string, fromVoice = false) => {
    if (!message.trim() || sending) return;

    const optimisticUserMessage: Message = { role: "user", content: message };
    setMessages((current) => [...current, optimisticUserMessage]);
    setInput("");
    setSending(true);
    setError("");
    if (fromVoice) setVoiceState("processing");

    try {
      const payload = await apiFetch<{
        session_id: string;
        message: Message;
        retrievals: Retrieval[];
      }>("/api/chat/query", {
        method: "POST",
        body: JSON.stringify({
          message,
          act_filter: corpus,
          session_id: activeSessionId
        })
      });

      setActiveSessionId(payload.session_id);
      setMessages((current) => [...current, payload.message]);
      setRetrievals(payload.retrievals);

      if (fromVoice) {
        speakText(payload.message.content);
      }

      void apiFetch<{ sessions: SessionItem[] }>("/api/chat/sessions")
        .then((sessionPayload) => setSessions(sessionPayload.sessions))
        .catch(() => undefined);
    } catch (err) {
      setMessages((current) => current.slice(0, -1));
      setInput(message);
      setError(err instanceof Error ? err.message : "Query could not be analyzed.");
      if (fromVoice) setVoiceState("idle");
    } finally {
      setSending(false);
    }
  }, [sending, corpus, activeSessionId]);

  async function handleSend() {
    await sendMessage(input.trim());
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

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = "en-IN";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    /* Try to select a good voice */
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.toLowerCase().includes("google") ||
          v.name.toLowerCase().includes("natural") ||
          v.name.toLowerCase().includes("neural"))
    ) || voices.find((v) => v.lang === "en-IN") || voices.find((v) => v.lang.startsWith("en"));

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
    recognition.lang = "en-IN";
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
        void sendMessage(transcript, true);
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
    return <main className="loading-shell">Loading legal workspace...</main>;
  }

  return (
    <main className="chat-page-shell">
      <div className="chat-photo-wash" />

      <section className="chat-topbar">
        <div>
          <div className="eyebrow-pill">BNS Legal Intelligence Desk</div>
          <h1>Indian Police and Criminal Law Research Workspace</h1>
          <p>BNS, BNSS, and BSA legal analysis with session memory, corpus targeting, and AI brief generation.</p>
        </div>
        <div className="status-pill-row">
          <span className="status-pill">Institutional Access</span>
          <span className="status-pill status-pill-live">Live Retrieval</span>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="sidebar-panel">
          <div className="sidebar-head">
            <div className="seal-mark small">AI</div>
            <div>
              <strong>Investigation Desk</strong>
              <span>Session control and case memory</span>
            </div>
          </div>

          {user ? (
            <div className="profile-card">
              <div className="profile-name">{user.name}</div>
              <div className="profile-email">{user.email}</div>
              <button className="secondary-button" onClick={handleLogout} type="button">
                Sign Out
              </button>
            </div>
          ) : null}

          <button className="primary-light-button" onClick={handleCreateSession} type="button">
            New Legal Brief
          </button>

          <div className="section-kicker">Case History</div>
          <div className="session-list">
            {sessions.map((session) => (
              <div className={`session-row ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                <button
                  className="session-item"
                  onClick={() => void loadSession(session.id)}
                  type="button"
                >
                  {session.title}
                </button>
                <button
                  aria-label={`Delete ${session.title}`}
                  className="delete-session-button"
                  onClick={() => void handleDeleteSession(session.id)}
                  title="Delete case history"
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="chat-main-panel">
          <div className="overview-grid">
            <article className="overview-card main">
              <div className="mini-kicker">Command Overview</div>
              <h2>Ask like an investigator. Read like a legal researcher.</h2>
              <p>
                Search offences, procedure, and evidence law with a polished institutional interface
                inspired by Indian police review desks, statute files, and courtroom research systems.
              </p>
            </article>

            <article className="overview-card side">
              <strong>Acts in scope</strong>
              <span>BNS, BNSS, and BSA criminal-law analysis.</span>
              <strong>Best query style</strong>
              <span>Section number, offence scenario, arrest question, or evidence issue.</span>
            </article>
          </div>

          <div className="corpus-bar">
            <label htmlFor="corpus">Target Legal Corpus</label>
            <select id="corpus" value={corpus} onChange={(e) => setCorpus(e.target.value)}>
              {corpusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div className="messages-panel" ref={messagesPanelRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                State a criminal law question, cite a section, or describe a police-investigation scenario under BNS, BNSS, or BSA.
              </div>
            ) : (
              messages.map((message, index) => (
                <article
                  key={`${message.role}-${index}`}
                  className={`message-card ${message.role === "user" ? "user" : "assistant"}`}
                >
                  <div className="message-role">{message.role === "user" ? "You" : "Legal AI"}</div>
                  <div className="message-content">{message.content}</div>
                </article>
              ))
            )}
          </div>

          {retrievals.length > 0 ? (
            <div className="retrieval-panel">
              <div className="section-kicker">Retrieved Provisions</div>
              <div className="retrieval-grid">
                {retrievals.map((item, index) => (
                  <article key={`${item.act}-${item.section}-${index}`} className="retrieval-card">
                    <strong>
                      {item.act} Section {item.section}
                    </strong>
                    <span>{item.title}</span>
                    <p>{item.chapter}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {error ? <div className="error-banner compact">{error}</div> : null}

          {/* ── Live Transcript Banner ────────────────────── */}
          {voiceState === "recording" && liveTranscript ? (
            <div className="voice-transcript-banner">
              <div className="voice-transcript-label">
                <span className="voice-pulse-dot" />
                Live Transcription
              </div>
              <div className="voice-transcript-text">{liveTranscript}</div>
            </div>
          ) : null}

          {/* ── Voice Status Banner ──────────────────────── */}
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
              AI is reading the response aloud
              <button className="voice-stop-btn" onClick={stopSpeaking} type="button" title="Stop speaking">
                <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>
                Stop
              </button>
            </div>
          ) : null}

          {/* ── Composer (text + voice) ─────────────────── */}
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
              placeholder="e.g. 'BNS Section 103', 'What constitutes murder under BNS?', 'What is the arrest procedure for a cognizable offence?'"
              rows={3}
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
                  {voiceState === "recording" ? (
                    /* Stop / square icon when recording */
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                      <rect x="5" y="5" width="12" height="12" rx="3" fill="currentColor" />
                    </svg>
                  ) : voiceState === "speaking" ? (
                    /* Speaker icon when speaking */
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="5" width="12" height="12" rx="3" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    /* Microphone icon (idle/processing) */
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="8" y="2" width="6" height="12" rx="3" />
                      <path d="M4 10a7 7 0 0 0 14 0" />
                      <line x1="11" y1="17" x2="11" y2="20" />
                      <line x1="8" y1="20" x2="14" y2="20" />
                    </svg>
                  )}
                  {voiceState === "recording" ? (
                    <span className="voice-ring" />
                  ) : null}
              </button>
              {!voiceSupported ? (
                <span className="voice-unavailable">Voice chat is unavailable in this browser.</span>
              ) : null}
              <button className="send-button" onClick={() => void handleSend()} type="button" disabled={sending}>
                {sending ? "Analyzing..." : "Analyze Query"}
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
