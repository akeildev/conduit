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
  { t: "No API keys to wire up", d: "It uses the CLI you've already installed and signed into. Nothing new to provision.", ic: "M7 11V7a5 5 0 0 1 10 0v4|M5 11h14v10H5z" },
  { t: "Use what you already pay for", d: "Your Claude or Codex subscription becomes the backend. No separate per-token API bill.", ic: "M3 7h18v10H3z|M3 11h18|M7 15h2" },
  { t: "One format, any CLI", d: "Swap Claude for Codex without touching your app — both stream the exact same event shape.", ic: "M4 7h11l-3-3|M20 17H9l3 3" },
  { t: "Typed events, not raw text", d: "You read clean objects — assistant text, tool calls, a final result, typed errors. Never raw stdout.", ic: "M4 6h16|M4 12h10|M4 18h7" },
  { t: "Bring your own CLI", d: "Add a new CLI with a small config file. No new adapter code, no rebuild.", ic: "M12 5v14|M5 12h14" },
  { t: "Zero deps, MIT, readable", d: "One small library, no dependencies, source you can read in an afternoon.", ic: "M9 18l6-6-6-6" },
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
            <span className="pill"><span className="dot" /> Open source · MIT · zero dependencies</span>
            <h1 className="h1">Build on the AI subscription<br /><span className="accent">you already pay for.</span></h1>
            <p className="lede">
              Conduit turns the Claude or Codex CLI already on your machine into a streaming
              backend for your app — one clean event stream, no API keys, no per-token bill.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary" href={REPO}><GitHubMark /> Get started</a>
              <a className="btn btn-ghost" href={DOCS}>Read the docs</a>
            </div>
            <p className="trust">Works with <b>Claude Code</b>, <b>Codex</b>, or any CLI that prints JSON.</p>

            <div className="code hero-code">
              <div className="code-bar"><span className="tl" /><span className="tl" /><span className="tl" /><span className="fname">app.ts</span></div>
              <pre>
{`import { getAdapter } from `}<span className="s">&quot;conduit-runtime&quot;</span>{`;

`}<span className="c">// the CLI you already have — no API key</span>{`
`}<span className="k">const</span>{` codex = getAdapter(`}<span className="s">&quot;codex&quot;</span>{`);
`}<span className="k">const</span>{` turn  = `}<span className="k">await</span>{` codex.spawn({ prompt: `}<span className="s">&quot;summarize this repo&quot;</span>{`, cwd: `}<span className="s">&quot;.&quot;</span>{` });

`}<span className="c">// one clean stream, whatever CLI is underneath</span>{`
`}<span className="k">for await</span>{` (`}<span className="k">const</span>{` event `}<span className="k">of</span>{` codex.readEvents(turn, ctx)) {
  console.log(event.kind); `}<span className="c">// assistant_text · tool_call · final_result</span>{`
}`}
              </pre>
            </div>
          </div>
        </header>

        {/* Why */}
        <section className="section bordered">
          <div className="wrap section-head">
            <span className="eyebrow">Why Conduit</span>
            <h2 className="h2">Adding AI to an app is more plumbing than it should be.</h2>
            <p className="lede">
              The usual path means API keys, a per-token bill, and a different SDK for every model.
              But you already pay for a coding-agent CLI sitting right there on your machine.
              Conduit lets your app run on that — and gives you one tidy stream to build against.
            </p>
          </div>
        </section>

        {/* How it works */}
        <section className="section bordered">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">How it works</span>
              <h2 className="h2">Three steps. No magic.</h2>
            </div>
            <div className="steps">
              <div className="step">
                <div className="n">1</div>
                <h3>Point it at your CLI</h3>
                <p>Tell Conduit to use <code>claude</code>, <code>codex</code>, or any CLI that streams JSON. It finds the binary on your PATH.</p>
              </div>
              <div className="step">
                <div className="n">2</div>
                <h3>It runs &amp; translates</h3>
                <p>Conduit spawns the CLI for each turn and converts its native output into one simple, typed event stream.</p>
              </div>
              <div className="step">
                <div className="n">3</div>
                <h3>Your app reads the stream</h3>
                <p>You loop over clean events — text, tool calls, the final result. Same shape no matter which CLI ran.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="section bordered">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">For everyday devs</span>
              <h2 className="h2">What you actually get.</h2>
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
              <h2 className="h2">A new CLI is a config file, not a code change.</h2>
              <p className="lede">
                If a CLI prints line-by-line JSON, describe how to run it and how to read its
                output. Register it, and your app drives it like any other — same event stream,
                no adapter to write.
              </p>
            </div>
            <div className="code">
              <div className="code-bar"><span className="tl" /><span className="tl" /><span className="tl" /><span className="fname">my-cli.ts</span></div>
              <pre>
{`registerProvider(defineGenericCli({
  `}<span className="k">id</span>{`: `}<span className="s">&quot;mycli&quot;</span>{`,
  `}<span className="k">binary</span>{`: `}<span className="s">&quot;mycli&quot;</span>{`,
  `}<span className="k">argv</span>{`: { flags: [`}<span className="s">&quot;--stream&quot;</span>{`], prompt: { mode: `}<span className="s">&quot;positional&quot;</span>{` } },
  `}<span className="k">mapping</span>{`: { rules: [
    { match: [{ field: `}<span className="s">&quot;type&quot;</span>{`, equals: `}<span className="s">&quot;text&quot;</span>{` }],
      emit: [{ kind: `}<span className="s">&quot;assistant_text&quot;</span>{`,
        fields: { text: { path: `}<span className="s">&quot;content&quot;</span>{` } } }] },
  ] },
}));`}
              </pre>
            </div>
          </div>
        </section>

        {/* Get started */}
        <section className="section bordered get">
          <div className="wrap">
            <span className="eyebrow">Get started</span>
            <h2 className="h2">Up and running in a minute.</h2>
            <div className="install">
              <div className="row"><span className="pfx">$</span><span className="cmd">npm install conduit-runtime</span></div>
              <div className="row"><span className="pfx">$</span><span className="cmd">git clone https://github.com/akeildev/conduit &amp;&amp; cd conduit &amp;&amp; npm test</span></div>
            </div>
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
          <div>Subscription as a Runtime · MIT · <a href={REPO}>github.com/akeildev/conduit</a></div>
        </div>
      </footer>
    </>
  );
}
