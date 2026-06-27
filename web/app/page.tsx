const REPO = "https://github.com/akeildev/conduit";
const DOCS = `${REPO}/blob/main/docs/CONDUIT.md`;

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const BENEFITS = [
  { t: "No API keys", d: "Uses the CLI you already signed into.", ic: "M7 11V7a5 5 0 0 1 10 0v4|M5 11h14v10H5z" },
  { t: "Use what you pay for", d: "Your subscription is the backend.", ic: "M3 7h18v10H3z|M3 11h18|M7 15h2" },
  { t: "One format, any CLI", d: "Swap Claude for Codex, app unchanged.", ic: "M4 7h11l-3-3|M20 17H9l3 3" },
  { t: "Typed events", d: "Clean objects, not raw stdout.", ic: "M4 6h16|M4 12h10|M4 18h7" },
  { t: "Bring your own CLI", d: "Add one with a config file.", ic: "M12 5v14|M5 12h14" },
  { t: "Zero deps · MIT", d: "One small library you can read.", ic: "M9 18l6-6-6-6" },
];

export default function Home() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <div className="brandmark"><span className="logo-dot" aria-hidden /> Conduit</div>
          <div className="nav-links">
            <a className="btn btn-ghost btn-sm" href={DOCS}>Docs</a>
            <a className="btn btn-primary btn-sm" href={REPO}><GitHubMark /> GitHub</a>
          </div>
        </div>
      </nav>

      <main>
        {/* Hero */}
        <header className="hero">
          <div className="wrap">
            <span className="pill"><span className="dot" /> Open source · MIT</span>
            <h1 className="h1">Build on the AI subscription<br /><span className="accent">you already pay for.</span></h1>
            <p className="lede">
              Conduit runs the Claude or Codex CLI on your machine and turns it into one
              clean event stream. No API keys. No token bills.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary" href={REPO}><GitHubMark /> Get started</a>
              <a className="btn btn-ghost" href={DOCS}>Read the docs</a>
            </div>
            <p className="trust">Claude Code · Codex · any CLI that prints JSON</p>

            <div className="code hero-code">
              <div className="code-bar"><span className="tl" /><span className="tl" /><span className="tl" /><span className="fname">terminal</span></div>
              <pre>
{`$ `}<span className="k">node bin/conduit.ts run codex</span>{` `}<span className="s">&quot;summarize this repo&quot;</span>{`

`}<span className="c">· session started</span>{`
assistant   A small Node library that normalizes any
            agent CLI into one canonical event stream.
tool        shell  ls -R
done        stop=completed · in=14k out=120`}
              </pre>
            </div>
          </div>
        </header>

        {/* How it works */}
        <section className="section bordered">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">How it works</span>
              <h2 className="h2">Three steps.</h2>
            </div>
            <div className="steps">
              <div className="step">
                <div className="n">1</div>
                <h3>Point it at your CLI</h3>
                <p><code>claude</code>, <code>codex</code>, or any JSON CLI.</p>
              </div>
              <div className="step">
                <div className="n">2</div>
                <h3>It runs &amp; translates</h3>
                <p>Conduit normalizes the output for you.</p>
              </div>
              <div className="step">
                <div className="n">3</div>
                <h3>Read one clean stream</h3>
                <p>Typed events — same shape, any CLI.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="section bordered">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Why devs use it</span>
              <h2 className="h2">Less plumbing.</h2>
            </div>
            <div className="benefits">
              {BENEFITS.map((b) => (
                <div className="benefit" key={b.t}>
                  <Icon d={b.ic} />
                  <h3>{b.t}</h3>
                  <p>{b.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Bring your own CLI */}
        <section className="section bordered">
          <div className="wrap split">
            <div className="split-text">
              <span className="eyebrow">Bring your own CLI</span>
              <h2 className="h2">A config file, not a code change.</h2>
              <p className="lede">If a CLI prints JSON, declare it in a manifest — no adapter to write.</p>
            </div>
            <div className="code">
              <div className="code-bar"><span className="tl" /><span className="tl" /><span className="tl" /><span className="fname">conduit.clis.json</span></div>
              <pre>
{`{
  `}<span className="k">&quot;id&quot;</span>{`: `}<span className="s">&quot;mycli&quot;</span>{`,
  `}<span className="k">&quot;binary&quot;</span>{`: `}<span className="s">&quot;mycli&quot;</span>{`,
  `}<span className="k">&quot;argv&quot;</span>{`: { &quot;prompt&quot;: { &quot;mode&quot;: `}<span className="s">&quot;positional&quot;</span>{` } },
  `}<span className="k">&quot;mapping&quot;</span>{`: { &quot;rules&quot;: [
    { &quot;match&quot;: [{ &quot;field&quot;: `}<span className="s">&quot;type&quot;</span>{`, &quot;equals&quot;: `}<span className="s">&quot;text&quot;</span>{` }],
      &quot;emit&quot;: [{ &quot;kind&quot;: `}<span className="s">&quot;assistant_text&quot;</span>{` }] }
  ] }
}`}
              </pre>
            </div>
          </div>
        </section>

        {/* Get started */}
        <section className="section bordered get">
          <div className="wrap">
            <h2 className="h2">Clone it. Run it.</h2>
            <div className="install">
              <div className="row"><span className="pfx">$</span><span className="cmd">git clone https://github.com/akeildev/conduit</span></div>
              <div className="row"><span className="pfx">$</span><span className="cmd">cd conduit &amp;&amp; node bin/conduit.ts detect</span></div>
            </div>
            <p className="trust">Runs on Node ≥ 23.6 — no build, no install, zero dependencies.</p>
            <div className="cta-row">
              <a className="btn btn-primary" href={REPO}><GitHubMark /> Star on GitHub</a>
              <a className="btn btn-ghost" href={DOCS}>Read the docs</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <div className="brandmark" style={{ fontSize: 15 }}><span className="logo-dot" aria-hidden /> Conduit</div>
          <div>MIT · <a href={REPO}>github.com/akeildev/conduit</a></div>
        </div>
      </footer>
    </>
  );
}
