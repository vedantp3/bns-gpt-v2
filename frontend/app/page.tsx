import { API_BASE_URL } from "@/lib/api";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function readError(searchParams: Record<string, string | string[] | undefined>) {
  const code = typeof searchParams.error === "string" ? searchParams.error : "";
  const message = typeof searchParams.message === "string" ? searchParams.message : "";

  switch (code) {
    case "oauth":
      return `Google sign-in could not be completed.${message ? ` ${message}` : ""}`;
    case "userinfo":
      return "Google sign-in completed, but user details could not be retrieved.";
    case "db":
      return `Account setup failed.${message ? ` ${message}` : ""}`;
    default:
      return "";
  }
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = (await searchParams) || {};
  const error = readError(resolvedSearchParams);

  return (
    <main className="login-page">
      <section className="login-hero">
        <div className="login-hero-photo" />
        <div className="login-hero-grid" />

        <div className="login-hero-copy">
          <span className="eyebrow-pill">BNS Legal Intelligence Desk</span>
          <h1>Indian criminal law research for police, courts, and investigators.</h1>
          <p>
            A legal intelligence workspace for the Bharatiya Nyaya Sanhita, Bharatiya Nagarik
            Suraksha Sanhita and Bharatiya Sakshya Adhiniyam — answers grounded in the statute
            text, with the sections they rely on.
          </p>

          <div className="hero-stat-grid">
            <article className="glass-card">
              <strong>Legal Research</strong>
              <span>Search provisions, compare sections, and explain offences quickly.</span>
            </article>
            <article className="glass-card">
              <strong>Investigation Ready</strong>
              <span>Built for case review, arrest procedure, evidence flow, and legal brief preparation.</span>
            </article>
            <article className="glass-card">
              <strong>Multilingual &amp; Voice</strong>
              <span>Answers in English, Hindi and six other Indian languages, typed or spoken.</span>
            </article>
          </div>
        </div>

        <aside className="hero-side-brief">
          <h3>Operational Snapshot</h3>
          <div className="hero-brief-list">
            <div className="hero-brief-item">
              <strong>BNS</strong>
              <span>Substantive criminal law analysis for offences, ingredients, and punishments.</span>
            </div>
            <div className="hero-brief-item">
              <strong>BNSS + BSA</strong>
              <span>Procedure and evidence support for arrest, trial stages, statements, and proof.</span>
            </div>
          </div>
        </aside>
      </section>

      <section className="login-panel-wrap">
        <div className="login-panel">
          <div className="login-panel-head">
            <div className="seal-mark">
              <img src="/images/scales.svg" alt="" width={38} height={38} />
            </div>
            <div>
              <h2>Secure Access</h2>
              <p>Enter the legal intelligence workspace used for BNS, BNSS, and BSA query support.</p>
            </div>
          </div>

          <div className="trust-pill-row">
            <span className="trust-pill">Police and legal workflow</span>
            <span className="trust-pill">Google-authenticated entry</span>
            <span className="trust-pill">Saved research sessions</span>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="feature-stack">
            <article className="feature-card">
              <div className="feature-icon">⚖</div>
              <div>
                <h3>BNS legal brief generation</h3>
                <p>Structured plain-language explanations, statutory elements, exceptions, and consequences.</p>
              </div>
            </article>

            <article className="feature-card">
              <div className="feature-icon">⌕</div>
              <div>
                <h3>Fast statutory lookup</h3>
                <p>Search BNS, BNSS, and BSA provisions with a workflow suited to police and legal review.</p>
              </div>
            </article>

            <article className="feature-card">
              <div className="feature-icon">▣</div>
              <div>
                <h3>Persistent investigation history</h3>
                <p>Return to past legal scenarios, case questions, and ongoing research sessions from one workspace.</p>
              </div>
            </article>
          </div>

          <div className="divider-label">Authorized Sign In</div>

          <a className="primary-auth-button" href={`${API_BASE_URL}/auth/google`}>
            <span className="google-mark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
                <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6.1z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.8 6.1C6.6 42.6 14.6 48 24 48z" />
              </svg>
            </span>
            Continue with Google
          </a>

          <p className="panel-foot-copy">
            <strong>Private research workspace.</strong> Sessions are tied to your account so officers,
            advocates, researchers, and students can continue work without losing context.
          </p>
        </div>
      </section>
    </main>
  );
}
