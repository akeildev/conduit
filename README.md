<h1 align="center">Conduit</h1>

<p align="center">
  <strong>Subscription as a Runtime.</strong><br>
  Turn any agent CLI you already pay for — Claude, Codex, your own —
  into the engine that powers an app.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#bring-your-own-cli-by-config-not-code">Bring your own CLI</a> ·
  <a href="#the-proof">The proof</a> ·
  <a href="docs/CONDUIT.md">Docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-0d0d0d" alt="MIT License">
  <img src="https://img.shields.io/badge/runtime-Node%20%E2%89%A523.6-0d0d0d" alt="Node >= 23.6">
  <img src="https://img.shields.io/badge/deps-zero-0d0d0d" alt="Zero runtime deps">
</p>

---

## What Conduit is

You already pay for a coding-agent CLI. Conduit treats that subscription as a **runtime**:
it spawns the CLI as a subprocess, normalizes its wildly different native stdout into **one
canonical event stream**, and hands that stream to your app like an API.

```
bring-your-own-CLI   →   Conduit   →   one canonical event stream   →   your app
  (claude / codex /        engine        (one renderer, typed errors)
   any JSONL CLI)
```

Two ways to bring a CLI online:

- **By config (no code)** — if the CLI prints line-delimited JSON, write a
  `GenericCliSpec` and you're done. This is the part most runtimes *don't* have.
- **By code** — for CLIs that need bespoke logic (streaming-delta accumulation, JSON-RPC
  over stdio), implement the small `ProviderAdapter` contract. A hand-written **Codex
  adapter** ships as a worked reference.

> Conduit is the extracted, standalone runtime kernel from the
> [Basics](https://github.com/akeildev) platform. Zero runtime dependencies; runs `.ts`
> directly on Node ≥ 23.6 via native type-stripping.

---

## Quickstart

No install, no registry — clone it and run the CLI. Node ≥ 23.6 runs the `.ts` sources
directly (native type-stripping), so there's nothing to build.

```bash
git clone https://github.com/akeildev/conduit.git
cd conduit

# which agent CLIs are installed + signed in?
node bin/conduit.ts detect

# run one turn through the CLI you already have
node bin/conduit.ts run codex "summarize this repo"
```

You get one normalized stream, whatever CLI ran underneath:

```
· session started
assistant   A small Node library that normalizes any agent CLI…
tool        shell  ls -R
done        stop=completed · in=14k out=120
```

### Use it in your code

Drop the repo next to your project and import the sources directly:

```ts
import { getAdapter, makeCounterContext } from "./conduit/src/index.ts";

const codex = getAdapter("codex")!;
const child = await codex.spawn({ agentRef: "demo", cwd: process.cwd(), prompt: "hi" });
const ctx = makeCounterContext({ sessionKey: "s", conversationId: "c", agentRef: "demo", topic: "session:s" });

for await (const event of codex.readEvents(child, ctx)) {
  console.log(event.kind, event); // one canonical shape, any CLI
}
```

---

## Use it as a local API — power any app's AI feature

Run the gateway and Conduit becomes an HTTP endpoint any app can call — no API keys, no
per-token billing, your subscription is the backend:

```bash
node bin/conduit-serve.ts            # → http://127.0.0.1:8787
```

```js
import { conduitRun } from "./conduit/clients/conduit-client.js";

await conduitRun({
  // provider omitted → the gateway uses whichever CLI you're signed into
  // (precedence claude → codex; pin with CONDUIT_DEFAULT_PROVIDER or pass provider).
  prompt: "summarize this repo",
  onEvent: (e) => { if (e.kind === "assistant_text") append(e.text); },
});
```

Two built-in providers — **`claude`** and **`codex`**. `GET /detect` lists installed CLIs;
`GET /health` reports the resolved default; `POST /run` streams canonical events as SSE. React hook
(`clients/useConduit.ts`) and a Next.js auth'd proxy route (`clients/next-route.ts`) included.
Full contract: [`docs/GATEWAY.md`](docs/GATEWAY.md).

---

## Bring your own CLI — by config, not code

A CLI invoked as `mycli --stream <prompt>` that prints `{"type":"text","content":"…"}`
then `{"type":"done"}` is online with this spec:

```ts
import { defineGenericCli, registerProvider } from "./conduit/src/index.ts";

registerProvider(defineGenericCli({
  id: "mycli",
  binary: "mycli",
  argv: { flags: ["--stream"], model: { flag: "--model" }, prompt: { mode: "positional" } },
  mapping: {
    rules: [
      { match: [{ field: "type", equals: "text"  }], emit: [{ kind: "assistant_text", fields: { text: { path: "content" } } }] },
      { match: [{ field: "type", equals: "error" }], emit: [{ kind: "provider_error", classifyFrom: "message" }] },
      { match: [{ field: "type", equals: "done"  }], emit: [{ kind: "final_result", fields: { stopReason: { const: "completed" } } }] },
    ],
  },
}));
```

Or declare a whole document of CLIs in a [`conduit.clis.json`](conduit.clis.json) manifest
and load it with `loadCliManifestFile(path)`. Full spec reference: [`docs/CONDUIT.md`](docs/CONDUIT.md).

---

## The proof

The headline claim — *config reproduces code* — is tested, not asserted. The repo ships
`codexCompatibleSpec` (Codex `exec --json` expressed entirely as a spec) and runs it over
the **real Codex fixtures** alongside the hand-written `codex.ts`, asserting they yield the
**same canonical event backbone**, kind-for-kind:

```
✔ declarative spec yields the SAME canonical backbone as the hand-written codex adapter, on every real Codex fixture
✔ declarative spec classifies the rate-limit + auth error fixtures to the right typed errorKind
… 14 pass, 0 fail
```

See [`test/conduit_generic.test.ts`](test/conduit_generic.test.ts).

---

## How it works

Conduit is grounded in a deep read of [Houston](https://github.com/gethouston/houston)'s
CLI-as-runtime design — re-implemented from scratch, never vendored — and goes one step
further with config-driven providers. The mechanism is documented hop-by-hop with
`file:line` citations in
[`docs/HOW-HOUSTON-CLI-RUNTIME-WORKS.md`](docs/HOW-HOUSTON-CLI-RUNTIME-WORKS.md), and the
build/extend guide is [`docs/CONDUIT.md`](docs/CONDUIT.md).

| Piece | File |
|---|---|
| Canonical event type | [`src/canonical.ts`](src/canonical.ts) |
| Typed error taxonomy | [`src/provider_error.ts`](src/provider_error.ts) |
| The provider contract | [`src/types.ts`](src/types.ts) |
| Config-driven adapter | [`src/generic.ts`](src/generic.ts) |
| Manifest loader | [`src/manifest.ts`](src/manifest.ts) |
| Hand-written Codex adapter | [`src/codex.ts`](src/codex.ts) |
| Hand-written Claude adapter | [`src/claude.ts`](src/claude.ts) |
| Local API gateway (HTTP+SSE) | [`bin/conduit-serve.ts`](bin/conduit-serve.ts) |

---

## Repo layout

| Path | What |
|---|---|
| `bin/` | the `conduit` CLI (`detect` / `run` / `providers`) + `conduit-serve` (the HTTP+SSE gateway) |
| `src/` | the runtime kernel — runs as-is on Node ≥ 23.6, zero dependencies |
| `clients/` | drop-in callers for the gateway — browser/Node client, React hook, Next.js route |
| `test/` | the test suite + real Codex fixtures |
| `docs/` | the understanding doc + build/extend guide |
| `web/` | the landing site (Next.js) — not part of the kernel; deployed separately |

> No npm install. Clone the repo and run the `.ts` directly (Node ≥ 23.6 strips types
> natively). Run the CLI in `bin/`, or drop `src/` next to your project and import it.

---

## License

MIT © akeildev
