/**
 * conduit-client.js — tiny client for the Conduit gateway (bin/conduit-serve.ts).
 *
 * Zero dependencies. Works in the browser and in Node ≥ 18 (both have fetch +
 * ReadableStream). `/run` is a POST with a JSON body, so this parses Server-Sent
 * Events off the fetch stream itself — EventSource only does GET, so it can't be used.
 *
 *   import { conduitRun, conduitDetect } from "./conduit-client.js";
 *
 *   await conduitRun({
 *     baseUrl: "http://127.0.0.1:8787",
 *     provider: "codex",
 *     prompt: "summarize this repo",
 *     onEvent: (e) => { if (e.kind === "assistant_text") append(e.text); },
 *   });
 */

/** List the agent CLIs installed + signed in on the gateway host. */
export async function conduitDetect({ baseUrl = "http://127.0.0.1:8787", token } = {}) {
  const res = await fetch(`${baseUrl}/detect`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`conduit detect failed: ${res.status}`);
  return res.json();
}

/**
 * Run one turn and stream canonical events to `onEvent`.
 *
 * @param {object}   opts
 * @param {string}   opts.provider      e.g. "codex" / "claude"
 * @param {string}   opts.prompt        the user's prompt for this turn
 * @param {string}  [opts.baseUrl]      gateway URL (default http://127.0.0.1:8787)
 * @param {string}  [opts.model]        model override (some CLIs require one)
 * @param {string}  [opts.cwd]          working dir the agent runs against
 * @param {boolean} [opts.enableTools]  toggle tool use (default: provider default)
 * @param {string}  [opts.token]        bearer token if the gateway sets CONDUIT_TOKEN
 * @param {(e:object)=>void} opts.onEvent   called once per canonical event
 * @param {AbortSignal} [opts.signal]   cancel the turn (kills the CLI subprocess)
 * @returns {Promise<{ok:boolean, error?:string, events:object[]}>}  resolves when the turn ends
 */
export async function conduitRun({
  baseUrl = "http://127.0.0.1:8787",
  provider,
  prompt,
  model,
  cwd,
  enableTools,
  token,
  onEvent,
  signal,
}) {
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ provider, prompt, model, cwd, enableTools }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch {}
    throw new Error(`conduit run failed: ${detail}`);
  }

  const events = [];
  let outcome = { ok: true, events };

  await parseSSE(res.body, (event, data) => {
    if (event === "message") {
      const e = safeParse(data);
      if (e) { events.push(e); onEvent?.(e); }
    } else if (event === "done") {
      outcome = { ok: true, events };
    } else if (event === "error") {
      outcome = { ok: false, error: safeParse(data)?.message ?? "unknown error", events };
    }
  });

  return outcome;
}

// ── SSE parsing off a fetch ReadableStream ────────────────────────────────────

async function parseSSE(stream, onFrame) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      // Frames are separated by a blank line.
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        emitFrame(frame, onFrame);
      }
    }
    if (buffer.trim()) emitFrame(buffer, onFrame);
  } finally {
    reader.releaseLock();
  }
}

function emitFrame(frame, onFrame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length) onFrame(event, dataLines.join("\n"));
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function authHeaders(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }
