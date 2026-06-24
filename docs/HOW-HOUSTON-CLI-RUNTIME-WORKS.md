# How Houston runs a CLI subscription as a runtime

**Audience:** an engineer (or an agent) about to extend Basics' Conduit layer.
**Purpose:** the mechanism doc for the studied reference — how Houston turns *the
user's own coding-agent CLI* (Claude Code / Codex / Gemini, run on the user's own
subscription) into the runtime that powers an app. Grounded in a direct read of the
Houston source at `~/refs/houston` (commit as cloned 2026-06-24); every claim cites
`file:line`. This is the "what to faithfully re-implement, and what to improve on"
companion to [`CONDUIT.md`](./CONDUIT.md).

> Basics re-implements this design in its own engine. **No Houston code is imported or
> vendored.** The point of this doc is to be honest about what Houston actually does so
> the Basics re-implementation is grounded in fact, not paraphrase.

---

## 0. The one-sentence model

> Houston is a local Rust HTTP+WS daemon (`houston-engine`) that **spawns the user's own
> agent CLI as a subprocess against a folder on disk**, normalizes that CLI's native
> streaming stdout into **one canonical `FeedItem` event type**, and broadcasts those
> events to any frontend over WebSocket. "Subscription as a runtime" = the engine is the
> brain; the CLI the user already pays for is the muscle; the UI is just a subscriber.

---

## 1. The end-to-end pipeline, traced on one turn

A user types a prompt in a Houston frontend. Here is every hop, naming the real
function/file at each step.

```
UI                POST /v1/agents/{agent_path}/sessions   { sessionKey, prompt, provider, model, … }
  │                 houston-engine-server/src/routes/sessions.rs  (start handler)
  ▼
engine-core       sessions::start()  → ACCEPT-THEN-STREAM: register, return sessionKey NOW,
  │                 spawn a tokio task   (houston-engine-core/src/sessions/mod.rs)
  ▼
turn lock         acquire per-(agent, session_key) lock  (same key queues; different keys run)
  │                 houston-engine-core/src/sessions/control.rs  (SessionTurnLocks)
  ▼
dispatch          SessionManager::spawn_session() → match provider.id() → spawn_claude / _codex / _gemini
  │                 houston-terminal-manager/src/session_dispatch.rs
  ▼
spawn             Command::new("claude")  -p --output-format stream-json --verbose
  │                   --include-partial-messages [--model] [--system-prompt-file] [--resume]
  │                 houston-terminal-manager/src/claude_command.rs:31  (configure_claude_command)
  │                 prompt is written to the child's STDIN, then stdin is dropped
  │                 houston-terminal-manager/src/cli_process.rs:35  (run_cli_process)
  ▼
read              two async BufReader tasks over the child's stdout + stderr
  │                 stdout NDJSON → parser::parse_event(line)         session_io.rs:136 (read_claude_stdout)
  │                 stderr lines  → provider.classify_stderr(line)    session_io.rs:57  (read_stderr_lines)
  ▼
normalize         each native line → zero-or-more canonical FeedItem
  │                 houston-terminal-manager/src/types.rs:225  (enum FeedItem)
  ▼
pump              SessionUpdate{Status|Feed|SessionId|ProcessPid} → callbacks
  │                 houston-agents-conversations/src/session_runner.rs  (spawn_and_monitor / pump)
  ▼
event             HoustonEvent::FeedItem{ agent_path, session_key, item }
  │                 houston-ui-events/src/lib.rs:108  (enum HoustonEvent)
  ▼
broadcast         BroadcastEventSink → WS endpoint /v1/ws  (topic session:{key} | agent:{path} | *)
  │                 houston-engine-server/src/ws.rs  (per-connection bounded mpsc, cap 1024)
  ▼
wire              EngineEnvelope{ v, id, kind:"event", ts, payload }
  │                 houston-engine-protocol/src/lib.rs:28
  ▼
UI                EngineWebSocket.onEvent → reducer mergeFeedItem → ChatPanel
                    ui/engine-client/src/ws.ts ; ui/chat/src/feed-to-messages.ts
```

The turn ends with a `result` line → `FeedItem::FinalResult{ cost_usd, duration_ms, usage }`
and a terminal `SessionStatus`.

---

## 2. The five subsystems, each as the reference really builds it

### 2.1 BYO-CLI acquisition — `cli-deps.json` + `houston-cli-bundle` + `houston-claude-installer`

Houston pins every CLI it ships or installs in **`cli-deps.json`** (repo root). Each entry:
`version`, `bundled` (bool), `binary_name`, `license`, optional `install_target`,
`ship_layout`, per-platform `urls` and `checksums`.

- **claude-code** is `"bundled": false` — its license forbids redistribution
  (`cli-deps.json:6`, `"license":"PROPRIETARY"`). So the engine **downloads it on first
  launch** and **sha256-verifies** it: `houston-claude-installer/src/lib.rs:255`
  (`install_to`) streams the platform URL into a `.partial` on the same filesystem,
  accumulates a SHA-256 (lib.rs:321), compares case-insensitively to the pinned checksum
  (lib.rs:359), `chmod +x`, then atomically renames into `~/.local/bin/claude`
  (Windows: `%LOCALAPPDATA%\Programs\claude\claude.exe`). Errors are a typed enum
  `ClaudeInstallError` (`Timeout | NetworkUnreachable | ChecksumMismatch | HttpError{status} | …`,
  classified at lib.rs:419). It runs as a non-blocking background task at boot
  (`ensure_and_upgrade`, lib.rs:88) and emits `ClaudeCliInstalling{progress_pct}` /
  `ClaudeCliReady` / `ClaudeCliFailed` events.
- **codex / composio / gemini** are `"bundled": true` and ride inside the `.app`/`.msi`
  under `resources/bin` (`cli-deps.json:25` onward). macOS combines per-arch binaries with
  `lipo -create` into one universal Mach-O (`ship_layout:"lipo-universal"`); Bun/SEA apps
  that can't lipo ship per-arch dirs (`"per-arch-dir"`). Staging is done by
  `scripts/fetch-cli-deps.sh`; version bumps by `scripts/bump-cli.sh`.
- **Runtime resolution** walks up from `current_exe()` to find the bundle's `bin/`
  (`houston-cli-bundle/src/lib.rs:77`, `bundled_bin_dir`), picks the per-arch composio dir
  with a Windows-on-ARM `IsWow64Process2` shim (`lib.rs:496`, `host_arch_for_composio`),
  and resolves the runtime-installed claude via `claude_install_path::cli_path`
  (`houston-terminal-manager/src/claude_install_path.rs:22`). Crucially, the spawn env's
  **PATH is the user's *login-shell* PATH**, not the bare process PATH
  (`claude_path::init`, `claude_path.rs:49`) — otherwise a GUI-launched `.app` can't find
  Homebrew/npm/cargo binaries.

### 2.2 Spawn + the wire — `houston-terminal-manager` + `houston-engine-protocol`

- **Exact Claude argv** (`claude_command.rs:31`): `claude -p --output-format stream-json
  --verbose --include-partial-messages [--model m] [--system-prompt-file f] [--resume id]`.
  Tool-gating is coarse and **pre-spawn**: tools-on adds `--dangerously-skip-permissions
  --disallowedTools Edit Write NotebookEdit`; pure-conversation passes `--allowedTools ""`.
  **There is no interactive permission round-trip** — every turn runs autonomously.
- **Prompt delivery is over stdin** (`cli_process.rs:35`), not argv — avoids the Windows
  32K command-line limit and arg-escaping bugs. Then stdin is dropped so the one-shot CLI
  doesn't hang waiting for more input.
- **The dispatch is hand-written `match provider.id()`** (`session_dispatch.rs`), with
  separate `read_claude_stdout` / `read_codex_stdout` / `read_gemini_stdout` parsers
  (`session_io.rs:110`). Only anthropic/openai/gemini are wired. **"Any ACP agent" is
  aspirational** — adding a runtime means writing a new spawn arm *and* a new parse arm.
  *(This is the exact limitation Basics' Conduit generic adapter removes — see §3.)*
- **The transport envelope** is `EngineEnvelope{ v, id, kind, ts, payload }`
  (`houston-engine-protocol/src/lib.rs:28`); `kind ∈ {Event, Req, Res, Ping, Pong}`.

### 2.3 The canonical event — `FeedItem`

Every provider's native output normalizes into one enum (`types.rs:225`):
`AssistantText / AssistantTextStreaming`, `Thinking / ThinkingStreaming`, `UserMessage`,
`ToolCall{name,input} / ToolResult{content,is_error}`, `SystemMessage`,
`ProviderError(ProviderError)`, `ContextCompacted{trigger,pre_tokens}`,
`ProviderSwitched`, `FinalResult{result,cost_usd,duration_ms,usage}`,
`FileChanges{created,modified}`. Errors normalize to a typed `ProviderError` taxonomy
(`RateLimited | Unauthenticated | …`) classified from stderr/result via a
`ProviderAdapter` trait whose default methods are no-ops the adapters override
(`provider/mod.rs`). **This is the property that makes the UI runtime-agnostic** — one
renderer for Claude *or* Codex *or* Gemini.

### 2.4 Server transport + backpressure — `houston-engine-server/src/ws.rs`

`/v1/ws` gives each connection a **bounded** mpsc queue (cap 1024). The drop policy
(`ws.rs:135`): streaming deltas (`AssistantTextStreaming`, `ThinkingStreaming`) are
**dropped silently** under load; `SessionStatus` **coalesces** (latest wins); everything
else is must-deliver and a drop emits a **`LagMarker`** so the client refetches via REST.
Clients subscribe to topics `session:{key}`, `agent:{path}`, or firehose `*`. Auth is a
bearer token written to `~/.houston/engine.json` at boot (`{version,port,pid,token_hash}`)
behind `auth.rs::require_bearer`. **Sessions are accept-then-stream**: the REST call
returns the `sessionKey` immediately and the turn streams over WS (`sessions/mod.rs`).

### 2.5 Files-first reactivity (Channel B) — `houston-file-watcher`

The agent writes files with its *own* Write/Edit tools, bypassing the REST API. A
`notify`-based, 500ms-debounced recursive watcher (`houston-file-watcher/src/lib.rs`)
catches those writes and `classify_change()` maps paths to events
(`.houston/activity/*`→`ActivityChanged`, `CLAUDE.md`→`ContextChanged`, else
`FilesChanged`), which the frontend turns into TanStack-Query cache invalidations
(`use-agent-invalidation.ts`). This is why the UI stays live whether the human, the
agent, or an external editor touched a file.

---

## 3. Solid vs. missing — what to re-implement, what to improve

**Solid, re-implement faithfully:**
- Login-shell PATH resolution before spawn (the #1 "works in my terminal, fails when
  spawned" bug). Basics: `engine/src/providers/path.ts`.
- Prompt-over-stdin + drop-stdin for one-shot CLIs. Basics: `claude.ts`/`codex.ts`/`generic.ts`.
- One canonical event type + typed error taxonomy + a single renderer. Basics:
  `packages/protocol/canonical.ts` (23-variant `CanonicalEvent`), `provider_error.ts`.
- Accept-then-stream + per-(agent,key) turn lock + bounded-channel WS with lag markers.
  Basics: `engine/src/sessions/`, `engine/src/ws/`, `engine/src/bus/`.
- sha256-verified download of the non-redistributable CLI; bundled per-arch staging of the
  others. (Basics treats pinning/bundling as a host concern; Conduit resolves BYO binaries
  off PATH.)

**Missing / aspirational in Houston — where Basics goes further:**
- **Adding a runtime is code, not config.** Houston needs a new `match` arm in both
  `session_dispatch.rs` and `session_io.rs` per CLI; "any ACP agent" is unbuilt. **Basics'
  Conduit `defineGenericCli(spec)` makes the broad class of already-JSONL CLIs a declarative
  manifest entry** (`engine/src/providers/generic.ts`, `engine/src/conduit/`). See
  [`CONDUIT.md`](./CONDUIT.md).
- **No human sign-off gate.** Every Houston turn runs `--dangerously-skip-permissions`. The
  only control is coarse pre-spawn tool gating. Basics builds the mediation chokepoint in P5
  (the `action_intercepted/held/denied` canonical events already exist in `canonical.ts`).
- **Tenant isolation is just directory paths behind a bearer token.** Houston has no
  per-tenant boundary; Basics makes the workspace the one hard isolation boundary (P4).
- **`cloud/` and `teams/` are README-only.** The multi-tenant control plane exists only as
  HTML design decks; the real self-host story is `always-on/` (same binary, `HOUSTON_BIND=0.0.0.0`).

---

## 4. Source index (for the next reader)

| Subsystem | Reference file(s) | Key symbol(s) |
|---|---|---|
| CLI pinning | `cli-deps.json` | per-CLI `version/bundled/urls/checksums` |
| Bundle resolution | `engine/houston-cli-bundle/src/lib.rs` | `bundled_bin_dir:77`, `host_arch_for_composio:496` |
| Claude install/verify | `engine/houston-claude-installer/src/lib.rs` | `ensure_and_upgrade:88`, `install_to:255` |
| Login-shell PATH | `engine/houston-terminal-manager/src/claude_path.rs` | `init:49` |
| Spawn + argv | `…/claude_command.rs`, `…/cli_process.rs` | `configure_claude_command:31`, `run_cli_process:35` |
| Dispatch (hand-written) | `…/session_dispatch.rs`, `…/session_io.rs` | `read_claude_stdout:136`, `read_stderr_lines:57` |
| Canonical event | `…/types.rs` | `enum FeedItem:225` |
| Provider trait | `…/provider/mod.rs` | `trait ProviderAdapter` |
| Wire envelope | `engine/houston-engine-protocol/src/lib.rs` | `EngineEnvelope:28` |
| Top-level event | `engine/houston-ui-events/src/lib.rs` | `enum HoustonEvent:108` |
| Server + WS + backpressure | `engine/houston-engine-server/src/ws.rs` | drop policy `:135` |
| Session lifecycle | `engine/houston-engine-core/src/sessions/mod.rs` | `start()` accept-then-stream |
| Files-first (Channel B) | `engine/houston-file-watcher/src/lib.rs` | `classify_change()` |
| TS client | `ui/engine-client/src/{client,ws}.ts` | `HoustonClient`, `EngineWebSocket` |
| Chat reducer | `ui/chat/src/feed-to-messages.ts` | `mergeFeedItem`, `feedItemsToMessages` |
