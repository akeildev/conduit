# Conduit Gateway — your AI feature as a local API

`bin/conduit-serve.ts` turns the agent CLI you already pay for into an HTTP endpoint
any app can call. No API keys, no per-token billing — your subscription is the runtime.

```
Browser / app  →  conduit-serve (localhost)  →  your CLI (claude / codex / …)
                  ↑ one canonical event stream, over Server-Sent Events
```

## Run it

```bash
git clone https://github.com/akeildev/conduit.git
cd conduit
node bin/conduit-serve.ts          # → http://127.0.0.1:8787
```

Requires Node ≥ 23.6 (runs the `.ts` sources directly via native type-stripping).

Env:

| var               | default            | meaning                                        |
| ----------------- | ------------------ | ---------------------------------------------- |
| `CONDUIT_PORT`    | `8787`             | listen port                                    |
| `CONDUIT_HOST`    | `127.0.0.1`        | bind address (loopback by design)              |
| `CONDUIT_TOKEN`   | _(off)_            | require `Authorization: Bearer <token>`        |
| `CONDUIT_ORIGIN`  | `*`                | CORS allow-origin for browser apps             |

## Endpoints

- `GET /health` → `{ ok, providers }`
- `GET /detect` → `DetectResult[]` — which CLIs are installed + signed in
- `POST /run` → **SSE** stream of canonical events
  - body: `{ provider, prompt, model?, cwd?, enableTools? }`
  - frames: `event: message` (one `CanonicalEvent`), then `event: done` or `event: error`

## Call it

Browser / Node (zero deps — `clients/conduit-client.js`):

```js
import { conduitRun } from "./conduit-client.js";
await conduitRun({
  provider: "codex",
  prompt: "summarize this repo",
  onEvent: (e) => { if (e.kind === "assistant_text") append(e.text); },
});
```

React (`clients/useConduit.ts`):

```tsx
const { text, run, running } = useConduit({ provider: "codex" });
<button onClick={() => run("explain this file")} disabled={running}>Ask</button>
<pre>{text}</pre>
```

Next.js — hide the gateway behind your own auth'd route: copy `clients/next-route.ts`
to `app/api/ai/route.ts`, then have the browser call `/api/ai` instead of the gateway.

## Event kinds you'll handle

`assistant_text` (the answer, may arrive in pieces) · `thinking` · `tool_call` /
`tool_result` · `provider_error` (`errorKind`: `RateLimited` / `Unauthenticated` / …) ·
`final_result` (`usage`, `stopReason`) · `system_message` · `session_status`.

## Production note

The gateway runs the real CLI against the real filesystem, so it is a **local,
self-hosted** runtime — keep it on loopback and put your app's auth in front of it
(see `next-route.ts`). Set `CONDUIT_TOKEN` if anything other than your app can reach it.
