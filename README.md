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

```bash
git clone https://github.com/akeildev/conduit.git
cd conduit
npm install        # devDeps only (typescript, @types/node) — no runtime deps
npm test           # 14 tests incl. the config-reproduces-code proof
npm run typecheck
```

Drive a turn:

```ts
import { getAdapter, makeCounterContext } from "conduit-runtime";

const codex = getAdapter("codex")!;
const child = await codex.spawn({ agentRef: "demo", cwd: process.cwd(), prompt: "hi", model: "gpt-5.5" });
const ctx = makeCounterContext({ sessionKey: "s", conversationId: "c", agentRef: "demo", topic: "session:s" });

for await (const event of codex.readEvents(child, ctx)) {
  // one canonical shape regardless of which CLI produced it
  console.log(event.kind, event);
}
```

---

## Bring your own CLI — by config, not code

A CLI invoked as `mycli --stream <prompt>` that prints `{"type":"text","content":"…"}`
then `{"type":"done"}` is online with this spec:

```ts
import { defineGenericCli, registerProvider } from "conduit-runtime";

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

---

## Repo layout

| Path | What |
|---|---|
| `src/` | the runtime kernel (the published package — compiled to `dist/` on `prepack`) |
| `test/` | the test suite + real Codex fixtures |
| `docs/` | the understanding doc + build/extend guide |
| `web/` | the marketing/landing site (Next.js) — **not** part of the runtime kernel; deployed separately |

> Published artifact: the package ships compiled **`dist/` (`.js` + `.d.ts`)**, so it
> imports by bare specifier on Node ≥ 18.18 (`import { getAdapter } from "conduit-runtime"`).
> The repo dev flow runs the `.ts` sources directly on Node ≥ 23.6.

---

## License

MIT © akeildev
