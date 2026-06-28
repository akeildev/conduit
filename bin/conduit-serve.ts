#!/usr/bin/env node
/**
 * conduit-serve — Conduit as a local API. "Subscription as a Runtime," over HTTP + SSE.
 *
 * This is the gateway that turns the user's installed agent CLI (Claude / Codex / any
 * JSONL CLI) into an HTTP endpoint any app can call — no API keys, no per-token billing,
 * just the subscription they already pay for. Zero dependencies: `node:http` + Conduit.
 *
 *   node bin/conduit-serve.ts                 # listen on 127.0.0.1:8787
 *   CONDUIT_PORT=9000 node bin/conduit-serve.ts
 *   CONDUIT_TOKEN=secret node bin/conduit-serve.ts   # require Authorization: Bearer secret
 *
 * Endpoints (all JSON in, SSE or JSON out):
 *   GET  /health            → { ok: true, providers: [...] }
 *   GET  /detect            → DetectResult[]  (which CLIs are installed + signed in)
 *   POST /run               → SSE stream of canonical events
 *        body: { provider, prompt, model?, cwd?, enableTools? }
 *        each event:  event: message \n data: <CanonicalEvent JSON> \n\n
 *        completion:  event: done    \n data: {"ok":true} \n\n
 *        failure:     event: error   \n data: {"message":"..."} \n\n
 *
 * By design it binds to LOOPBACK only — it runs the user's real CLI against their
 * filesystem, so it is a local, self-hosted runtime, not a public service. Put it behind
 * your own app's auth if you expose it. Set CONDUIT_TOKEN to require a bearer token.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { detectAgents, getAdapter, makeCounterContext } from "../src/index.ts";
import type { CanonicalEvent, SpawnedProcess } from "../src/index.ts";

const HOST = process.env.CONDUIT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CONDUIT_PORT ?? 8787);
const TOKEN = process.env.CONDUIT_TOKEN; // optional shared secret; off by default for local dev
const ORIGIN = process.env.CONDUIT_ORIGIN ?? "*"; // CORS allow-origin for browser apps

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/** Bearer-token gate. No token configured → open (local dev). */
function authorized(req: IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${TOKEN}`) return true;
  return url.searchParams.get("token") === TOKEN;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/** Stream one Conduit turn to the client as Server-Sent Events. */
async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const provider = typeof body.provider === "string" ? body.provider : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const model = typeof body.model === "string" && body.model.trim() ? body.model : undefined;
  const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
  const enableTools = typeof body.enableTools === "boolean" ? body.enableTools : undefined;

  if (!provider) return json(res, 400, { error: 'missing "provider" (e.g. "codex")' });
  if (!prompt) return json(res, 400, { error: 'missing "prompt"' });
  const adapter = getAdapter(provider);
  if (!adapter) return json(res, 404, { error: `unknown provider "${provider}". GET /detect to list installed CLIs.` });

  // Open the SSE stream.
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Comment line opens the stream immediately and defeats proxy buffering.
  res.write(": conduit stream open\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  const ctx = makeCounterContext({
    sessionKey: "gateway", conversationId: "gateway", agentRef: provider, topic: "session:gateway",
  });

  let child: SpawnedProcess | undefined;
  let aborted = false;
  req.on("close", () => { aborted = true; child?.kill("SIGTERM"); });

  try {
    child = await adapter.spawn({ agentRef: provider, cwd, prompt, ...(model ? { model } : {}), ...(enableTools !== undefined ? { enableTools } : {}) });
    for await (const event of adapter.readEvents(child, ctx)) {
      if (aborted) break;
      send("message", event satisfies CanonicalEvent);
    }
    if (!aborted) send("done", { ok: true });
  } catch (err) {
    if (!aborted) send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  if (!authorized(req, url)) return json(res, 401, { error: "unauthorized: set Authorization: Bearer <CONDUIT_TOKEN>" });

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const found = await detectAgents();
      return json(res, 200, { ok: true, providers: found.map((a) => a.id) });
    }
    if (req.method === "GET" && url.pathname === "/detect") {
      return json(res, 200, await detectAgents());
    }
    if (req.method === "POST" && url.pathname === "/run") {
      return await handleRun(req, res);
    }
    return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`conduit-serve → http://${HOST}:${PORT}  (GET /detect · POST /run)${TOKEN ? "  [token required]" : ""}`);
});
