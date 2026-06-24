const REPO = "https://github.com/akeildev/conduit";
const DOCS = `${REPO}/blob/main/docs/CONDUIT.md`;

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <div className="brandmark">
            <span className="logo-dot" aria-hidden />
            Conduit
          </div>
          <div className="nav-links">
            <a className="btn btn-ghost btn-sm" href={DOCS}>Docs</a>
            <a className="btn btn-primary btn-sm" href={REPO}>
              <GitHubMark /> GitHub
            </a>
          </div>
        </div>
      </nav>

      <main>
        {/* Hero */}
        <header className="hero">
          <div className="wrap">
            <span className="eyebrow">Subscription as a Runtime</span>
            <h1 className="h1">Your subscription<br />is the runtime.</h1>
            <p className="lede">
              You already pay for a coding-agent CLI. Conduit treats that subscription as a
              runtime — it spawns the CLI, normalizes its native output into one canonical
              event stream, and hands it to your app like an API.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 32, flexWrap: "wrap" }}>
              <a className="btn btn-primary" href={REPO}><GitHubMark /> View on GitHub</a>
              <a className="btn btn-ghost" href={DOCS}>Read the docs →</a>
            </div>

            <div className="flow" aria-label="bring your own CLI to your app through Conduit">
              <div className="flow-node">
                <div className="flow-k">Bring your own CLI</div>
                <div className="flow-v">claude · codex</div>
                <div className="flow-sub">…or any JSONL CLI</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-node is-brand">
                <div className="flow-k">Conduit</div>
                <div className="flow-v">the runtime</div>
                <div className="flow-sub">spawn · normalize · stream</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-node">
                <div className="flow-k">One canonical stream</div>
                <div className="flow-v">typed events</div>
                <div className="flow-sub">one renderer, typed errors</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-node">
                <div className="flow-k">Your app</div>
                <div className="flow-v">like an API</div>
                <div className="flow-sub">HTTP + WS ready</div>
              </div>
            </div>
          </div>
        </header>

        {/* Two ways */}
        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Two ways in</span>
              <h2 className="h2">Bring your own CLI — by config, not code.</h2>
              <p className="lede">
                Most runtimes make you hand-write a new adapter per CLI. Conduit makes the
                common case a declarative spec — and keeps the escape hatch for the rest.
              </p>
            </div>
            <div className="grid grid-2">
              <div className="card">
                <span className="chip">No code</span>
                <h3>A GenericCliSpec</h3>
                <p>
                  If the CLI prints line-delimited JSON, describe how to run it and how to map
                  its lines to canonical events. That&apos;s the whole adapter — declare it in a
                  manifest and register it at runtime.
                </p>
              </div>
              <div className="card">
                <span className="chip neutral">When you need it</span>
                <h3>A hand-written adapter</h3>
                <p>
                  For CLIs that need real logic — streaming-delta accumulation, JSON-RPC over
                  stdio, computed fields — implement the small <code>ProviderAdapter</code>
                  contract. A Codex adapter ships as a worked reference.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Code + proof */}
        <section className="section">
          <div className="wrap split">
            <div>
              <span className="eyebrow">The spec</span>
              <h2 className="h2" style={{ marginBottom: 18 }}>One object brings a CLI online.</h2>
              <div className="code">
                <div className="code-bar"><span className="fname">byo.ts</span></div>
                <pre>
{`registerProvider(defineGenericCli({
  `}<span className="t-key">id</span>{`: `}<span className="t-str">&quot;mycli&quot;</span>{`,
  `}<span className="t-key">binary</span>{`: `}<span className="t-str">&quot;mycli&quot;</span>{`,
  `}<span className="t-key">argv</span>{`: { flags: [`}<span className="t-str">&quot;--stream&quot;</span>{`], prompt: { mode: `}<span className="t-str">&quot;positional&quot;</span>{` } },
  `}<span className="t-key">mapping</span>{`: { rules: [
    { match: [{ field: `}<span className="t-str">&quot;type&quot;</span>{`, equals: `}<span className="t-str">&quot;text&quot;</span>{` }],
      emit: [{ kind: `}<span className="t-str">&quot;assistant_text&quot;</span>{`,
        fields: { text: { path: `}<span className="t-str">&quot;content&quot;</span>{` } } }] },
    { match: [{ field: `}<span className="t-str">&quot;type&quot;</span>{`, equals: `}<span className="t-str">&quot;done&quot;</span>{` }],
      emit: [{ kind: `}<span className="t-str">&quot;final_result&quot;</span>{` }] },
  ] },
}));`}
                </pre>
              </div>
            </div>

            <div>
              <span className="eyebrow">The proof</span>
              <h2 className="h2" style={{ marginBottom: 18 }}>Config reproduces code. Tested.</h2>
              <div className="proof">
                <p className="muted" style={{ margin: "0 0 14px", fontSize: 14 }}>
                  The Codex stream, expressed as a spec, runs over the <em>real</em> Codex
                  fixtures alongside the hand-written adapter — and yields the same canonical
                  backbone, kind-for-kind.
                </p>
                <div className="proof-line"><span className="tick">✔</span><span>declarative spec yields the SAME backbone as the hand-written codex adapter</span></div>
                <div className="proof-line"><span className="tick">✔</span><span>error fixtures classify to the right typed errorKind</span></div>
                <div className="proof-line"><span className="tick">✔</span><span>never throws on garbage · registry + manifest seam</span></div>
                <div className="metric">
                  <div><div className="n">14 / 14</div><div className="l">tests pass</div></div>
                  <div><div className="n">0</div><div className="l">runtime deps</div></div>
                  <div><div className="n">1</div><div className="l">canonical event type</div></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">Why it stays calm</span>
              <h2 className="h2">One stream. One renderer. Typed everything.</h2>
            </div>
            <div className="grid grid-4">
              <div className="feat card">
                <div className="k">Runtime-agnostic UI</div>
                <div className="v">Claude or Codex or your CLI — one canonical timeline, one renderer. No per-provider branches.</div>
              </div>
              <div className="feat card">
                <div className="k">Typed errors, not stderr</div>
                <div className="v">Rate-limit, auth, spawn, timeout — every failure normalizes to a typed kind with human copy.</div>
              </div>
              <div className="feat card">
                <div className="k">Never drops, never throws</div>
                <div className="v">Parsers degrade malformed input to a typed event. Backpressure-ready event classes built in.</div>
              </div>
              <div className="feat card">
                <div className="k">Zero dependencies</div>
                <div className="v">Runs <code>.ts</code> directly on Node ≥ 23.6 via native type-stripping. Nothing to bundle.</div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="section">
          <div className="wrap" style={{ textAlign: "center", padding: "8px 0 12px" }}>
            <span className="eyebrow">Open source · MIT</span>
            <h2 className="h2" style={{ margin: "14px auto 0", maxWidth: "18ch" }}>
              Point Conduit at a subscription. Ship.
            </h2>
            <div style={{ display: "flex", gap: 12, marginTop: 26, justifyContent: "center", flexWrap: "wrap" }}>
              <a className="btn btn-primary" href={REPO}><GitHubMark /> Star on GitHub</a>
              <a className="btn btn-ghost" href={DOCS}>Read the docs →</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <div className="brandmark" style={{ fontSize: 14 }}>
            <span className="logo-dot" aria-hidden /> Conduit
          </div>
          <div>Subscription as a Runtime · MIT · <a href={REPO} style={{ color: "var(--brand)" }}>github.com/akeildev/conduit</a></div>
        </div>
      </footer>
    </>
  );
}
