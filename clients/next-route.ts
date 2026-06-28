/**
 * next-route.ts — a Next.js App Router proxy in front of the Conduit gateway.
 *
 * Copy to `app/api/ai/route.ts`. The browser calls YOUR origin (/api/ai) — so you
 * add auth, rate limits, and a fixed provider/model here — and this route forwards
 * to the local Conduit gateway and pipes the SSE stream straight back. The gateway
 * (bin/conduit-serve.ts) stays bound to loopback and is never exposed to the browser.
 *
 *   Browser → /api/ai (your auth) → conduit-serve (localhost) → user's CLI subscription
 *
 * Env: CONDUIT_URL (default http://127.0.0.1:8787), CONDUIT_TOKEN (optional).
 */

export const runtime = "nodejs"; // streams a subprocess; not edge

const GATEWAY = process.env.CONDUIT_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.CONDUIT_TOKEN;

export async function POST(req: Request): Promise<Response> {
  // 1) YOUR app's gate goes here — session check, rate limit, quota, etc.
  //    e.g. const user = await auth(req); if (!user) return new Response("no", { status: 401 });

  const { prompt, provider = "codex", model } = await req.json().catch(() => ({}));
  if (!prompt) return Response.json({ error: "missing prompt" }, { status: 400 });

  // 2) Forward to the local gateway. Pin provider/model server-side so the browser
  //    can't pick an arbitrary one.
  const upstream = await fetch(`${GATEWAY}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ provider, prompt, model, enableTools: false }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json({ error: `gateway error ${upstream.status}: ${detail}` }, { status: 502 });
  }

  // 3) Pipe the SSE stream straight through to the browser.
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
