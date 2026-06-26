<!--
NOTE (standalone repo): file paths below use the Basics monorepo layout this doc was
authored in. In THIS standalone repo the mapping is:
  engine/src/providers/<x>.ts          → src/<x>.ts
  engine/src/conduit/<x>.ts            → src/<x>.ts
  packages/protocol/src/<x>.ts         → src/<x>.ts
  engine/test/conduit_generic.test.ts  → test/conduit_generic.test.ts
  engine/conduit.clis.json             → conduit.clis.json

  IMPORTANT: this standalone package ships ONLY ONE hand-written adapter — `src/codex.ts`.
  References below to `claude.ts` / `hermes.ts` and to `parseClaude` / `StreamAccumulator`
  describe the FULL Basics engine these were extracted from; they are NOT present in this
  repo. Use `src/codex.ts` as the worked hand-written reference, and `defineGenericCli`
  (Path A) to bring Claude or any other JSONL CLI online here.
-->

# Conduit — Subscription as a Runtime

> **Conduit** is the Basics runtime layer that turns *any* agent CLI a user already pays
> for — their Claude, their Codex, their own subscription — into the engine that drives a
> real app. Point Conduit at a CLI; it spawns it, normalizes its native stream into one
> canonical event type, and streams the result back like an API. **The subscription is the
> runtime.**
>
> ```
> bring-your-own-CLI   →   Conduit   →   one canonical event stream   →   your app
>   (claude / codex /        engine        (HTTP + WS, one renderer)
>    any JSONL CLI)
> ```

This document is **agent-optimized**: it is written to be read by an agent (or engineer)
about to add a CLI or extend the runtime. It states the contract, the exact files, the
copy-paste recipe, and the proof bar. For *how the studied reference (Houston) does this*,
read [`HOW-HOUSTON-CLI-RUNTIME-WORKS.md`](./HOW-HOUSTON-CLI-RUNTIME-WORKS.md) first.

---

## TL;DR for an agent

- **Goal:** make a new agent CLI usable as a Basics runtime.
- **Two paths.** If the CLI emits **line-delimited JSON on stdout**, write a
  **`GenericCliSpec`** (JSON/config — *no code*) and register it. If it needs bespoke
  logic (streaming-delta accumulation, JSON-RPC-over-stdio, double-encoded errors), write a
  **hand-written adapter** like `claude.ts`/`codex.ts`.
- **Everything funnels into one contract:** `ProviderAdapter`
  (`engine/src/providers/types.ts`). The bus, WS, SDK, and renderer only know that contract
  — never a specific provider.
- **The canonical event union is locked** (`packages/protocol/src/canonical.ts`). You map
  *into* it via `makeEvent(kind, ctx, payload)`; you never invent a new event shape.
- **Prove it** with a fixture-backed test that asserts your CLI's real stream normalizes to
  the right canonical backbone. See `engine/test/conduit_generic.test.ts`.

---

## The architecture in one screen

```
                ┌──────────────────────────────────────────────────────────────┐
  ProviderAdapter (engine/src/providers/types.ts) — the ONE contract everything uses
                │  id · detect() · probeAuth() · spawn(opts) ·                  │
                │  readEvents(child, ctx): AsyncIterable<CanonicalEvent> ·      │
                │  send(req) · parseLine(line, ctx) · setPermissionHook?()       │
                └──────────────────────────────────────────────────────────────┘
        ▲ implemented by                              ▲ implemented by
 ┌──────┴───────────────┐                     ┌───────┴────────────────────────────┐
 │ HAND-WRITTEN          │                     │ CONFIG-DRIVEN (Conduit)             │
 │ claude.ts · codex.ts  │                     │ defineGenericCli(GenericCliSpec)    │
 │ hermes.ts             │                     │  generic.ts + conduit/manifest.ts   │
 └───────────────────────┘                     └─────────────────────────────────────┘
        │ both reach the event source the SAME way:
        ▼
 readEvents → transport.ts linesToEvents()  →  parseLine()  →  makeEvent(kind, ctx, …)
        │
        ▼
 registry.ts  allAdapters() = [built-ins, ...registerProvider'd]   →   getAdapter(id)
        │
        ▼
 bus → ws → SDK → renderer   (one canonical timeline, provider-agnostic)
```

Key seams you will reuse, never reinvent:

| Need | Use | File |
|---|---|---|
| Resolve binary on the user's real PATH | `resolveBinaryOnLoginPath`, `buildChildEnv` | `engine/src/providers/path.ts` |
| Fold stdout lines → events | `linesToEvents(child, ctx, parseLine)` | `engine/src/providers/transport.ts` |
| Construct a canonical event | `makeEvent(kind, ctx, payload)` | `packages/protocol/src/canonical.ts` |
| Typed error taxonomy | `ProviderErrorKind`, `toHumanMessage`, `defaultRetryable` | `packages/protocol/src/provider_error.ts` |
| Register a provider at runtime | `registerProvider(adapter)` / `allAdapters()` | `engine/src/providers/registry.ts` |

---

## Path A — bring your own CLI with a `GenericCliSpec` (no code)

Use this when the CLI prints **NDJSON/JSONL on stdout** and maps to canonical events with
field extraction alone. You author a spec; `defineGenericCli(spec)` returns a full
`ProviderAdapter`.

### The spec, field by field

```ts
interface GenericCliSpec {
  id: string;               // stable provider id, e.g. "opencode"
  binary: string;           // resolved off the login-shell PATH, e.g. "opencode"
  discriminator?: string;   // dotted path to a line's type field (default "type")
  versionArgs?: string[];   // probe args (default ["--version"])
  displayName?: string;     // picker label
  errorRules?: { match: string; kind: ProviderErrorKind }[];  // regex → typed error

  argv: {                   // how to BUILD the headless argv (pure, testable)
    leading?: string[];     // subcommand prefix, e.g. ["exec"]
    flags?: string[];       // static flags, e.g. ["--json","--skip-git-repo-check"]
    resume?: { flag?: string; subcommand?: string[] };  // --resume <id>  OR  exec resume <id>
    model?: { flag: string; required?: boolean };       // --model / -m  (required→typed SpawnFailed)
    cwd?: { flag: string };                             // -C  (in addition to spawn cwd)
    systemPromptFile?: { flag: string };                // --system-prompt-file
    toolsEnabled?: string[];   // appended when tools on  (the autonomous/approval arm)
    toolsDisabled?: string[];  // appended when tools off
    prompt: { mode: "positional" | "flag" | "stdin"; flag?: string };
  };

  mapping: {                // how to MAP each native line → canonical events
    rules: {                // FIRST fully-matching rule wins
      match: { field: string; equals: string }[];   // AND of conditions; [] = catch-all
      emit: GenericEmit[];                            // [] = intentionally swallow (e.g. token deltas)
    }[];
    fallback?: boolean;     // unknown line → typed system_message "[unmapped …]" (default true)
  };
}

interface GenericEmit {
  kind: "assistant_text" | "assistant_text_streaming" | "thinking" | "thinking_streaming"
      | "tool_call" | "tool_result" | "system_message" | "session_status"
      | "context_compacted" | "final_result" | "provider_error";
  fields?: Record<string, FieldSource>;   // per canonical payload field
  classifyFrom?: string;   // provider_error: classify the value at this dotted path
  usagePath?: string;      // final_result: dotted path to a token-usage object
}

type FieldSource =
  | { path: string }       // primitive at "a.b.c"
  | { jsonPath: string }   // JSON.stringify the value at "a.b.c"  (for argsJson/resultJson)
  | { const: string | number | boolean }
  | { template: string };  // "{a.b} started"  — interpolate dotted paths
```

### Copy-paste starter

A CLI invoked as `mycli --stream <prompt>` that prints
`{"type":"text","content":"…"}` then `{"type":"done"}`:

```jsonc
{
  "id": "mycli",
  "binary": "mycli",
  "argv": { "flags": ["--stream"], "model": { "flag": "--model" }, "prompt": { "mode": "positional" } },
  "mapping": {
    "rules": [
      { "match": [{ "field": "type", "equals": "text"  }], "emit": [{ "kind": "assistant_text", "fields": { "text": { "path": "content" } } }] },
      { "match": [{ "field": "type", "equals": "error" }], "emit": [{ "kind": "provider_error", "classifyFrom": "message" }] },
      { "match": [{ "field": "type", "equals": "done"  }], "emit": [{ "kind": "final_result", "fields": { "stopReason": { "const": "completed" } } }] }
    ]
  }
}
```

### Register it

```ts
import { defineGenericCli, registerProvider } from "@basics/engine";
registerProvider(defineGenericCli(mySpec));               // one adapter
// …or a whole manifest file (the Basics analog of Houston's cli-deps.json):
import { loadCliManifestFile } from "@basics/engine";
loadCliManifestFile("engine/conduit.clis.json");          // many at once
```

`registerProvider` is idempotent per id and **cannot shadow a built-in** (a colliding id is
skipped). After registering, `getAdapter(id)` and `detectAgents()` see it like any built-in.

### Worked, proven example

`engine/src/conduit/examples.ts` ships `codexCompatibleSpec` — Codex `exec --json`
expressed entirely as a spec. The test `engine/test/conduit_generic.test.ts` runs it over
the **real Codex fixtures** and asserts it produces the **same canonical backbone** as the
hand-written `codex.ts`. That is the proof that "config, not code" is real.

---

## Path B — a hand-written adapter (when config isn't enough)

Reach for code when the CLI needs logic a declarative spec can't express:

- **Streaming-delta accumulation** (Claude's `stream_event` text deltas coalesced into a
  final block) → see `engine/src/providers/claude.ts` (`parseClaude`, `StreamAccumulator`).
- **JSON-RPC-over-stdio / request-response** (`codex app-server`, Hermes-over-ACP): implement
  `readEvents` as a notification **correlator** and use `send()` for the inbound channel.
  This is the seam the `ProviderAdapter` FORWARD-NOTE deliberately leaves open
  (`types.ts:8`). `parseLine` is ignored on this path.
- **Computed fields** (e.g. `isError = exit_code != 0`, double-JSON-encoded errors) →
  see `codex.ts` (`classifyCodexError`).

Implement `ProviderAdapter` directly, reuse the §"seams" table, and **never** throw from a
parser — degrade malformed input to a typed `system_message`/`provider_error`.

---

## Rules of the road (non-negotiable)

1. **One canonical type.** Map into `CanonicalEvent` via `makeEvent`. Never add a field the
   union doesn't have; evolve the union additively (bump `SCHEMA_VERSION`) if you truly must.
2. **Parsers never throw, never silently drop.** Garbage → a typed event. The fixtures
   discipline is *zero unmapped/unparsed lines in a real capture*.
3. **Resolve the login-shell PATH before spawn.** GUI-launched processes have a stripped
   PATH; `path.ts` already handles this — use it.
4. **One-shot CLIs: deliver the prompt, then end stdin** or the child hangs forever.
5. **Typed errors, not raw stderr.** Everything maps to a `ProviderErrorKind`.
6. **Prove it beyond unit tests.** A new provider needs a fixture captured from the *real*
   binary and a test that asserts the canonical backbone. Author the input, the code, and
   the assertion separately is circular — ground at least the happy path in a real capture.

---

## Where everything lives

| Thing | Path |
|---|---|
| The contract | `engine/src/providers/types.ts` (`ProviderAdapter`, `SpawnOptions`) |
| Canonical event union | `packages/protocol/src/canonical.ts` (`makeEvent`, `CanonicalEvent`) |
| Error taxonomy | `packages/protocol/src/provider_error.ts` (`ProviderErrorKind`) |
| Generic adapter factory | `engine/src/providers/generic.ts` (`defineGenericCli`) |
| Conduit manifest loader | `engine/src/conduit/manifest.ts` (`registerCliManifest`, `loadCliManifestFile`) |
| Worked specs | `engine/src/conduit/examples.ts` (`codexCompatibleSpec`, `echoJsonlSpec`) |
| Example manifest | `engine/conduit.clis.json` |
| Registry seam | `engine/src/providers/registry.ts` (`registerProvider`, `allAdapters`) |
| Hand-written references | `engine/src/providers/{claude,codex,hermes}.ts` |
| Shared seams | `engine/src/providers/{path,transport}.ts` |
| Proof | `engine/test/conduit_generic.test.ts` |
| Reference mechanism doc | `docs/conduit/HOW-HOUSTON-CLI-RUNTIME-WORKS.md` |

Public API: everything above is exported from `@basics/engine` (`engine/src/index.ts`).
