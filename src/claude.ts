/**
 * claude.ts — the Claude Code provider adapter (hand-written, alongside codex.ts).
 *
 * Claude Code runs headless as:
 *   claude -p <prompt> --output-format stream-json --verbose
 *        [--permission-mode acceptEdits]      (when tools are enabled)
 *        [--allowedTools ""]                  (when tools are disabled — pure conversation)
 *        [--model <model>] [--resume <session_id>]
 * emitting newline-delimited JSON (NDJSON) on stdout. This adapter (a) builds that argv +
 * spawns the CLI off the user's resolved login-shell PATH, and (b) maps each native NDJSON
 * line to the canonical event union.
 *
 * Claude is hand-written (not a GenericCliSpec) because one `assistant` line carries
 * `message.content[]` — an ARRAY of mixed blocks (text + thinking + tool_use) that fans
 * out to MULTIPLE canonical events, and tool results arrive on a separate `user` line.
 * The flat config spec maps one line → scalar paths; this needs real per-block code.
 *
 * Pinned against the installed Claude Code v2.1.x. The native shapes below are verified
 * against a REAL capture (see test/fixtures/claude/plain_text.jsonl + NOTES.md):
 *
 *   {type:"system", subtype:"init", session_id}                 → system_message  ("Session started (session=<id>)"; session_id is the --resume handle)
 *   {type:"assistant", message:{content:[{type:"text",text}]}}   → assistant_text  {text}
 *   {type:"assistant", message:{content:[{type:"thinking",…}]}}  → thinking        {text}
 *   {type:"assistant", message:{content:[{type:"tool_use",…}]}}  → tool_call       {toolName:name, callId:id, argsJson:input}
 *   {type:"user",      message:{content:[{type:"tool_result",…}]}}→ tool_result    {callId:tool_use_id, resultJson:content, isError:is_error}
 *   {type:"result", is_error:false, usage, total_cost_usd}        → final_result    {costUsd, usage, stopReason:stop_reason}
 *   {type:"result", is_error:true, ...}                          → provider_error  (classified)
 *   {type:"rate_limit_event", rate_limit_info}                   → session_status  {status:"rate_limit", detail}
 *   {type:"stream_event", ...}                                   → []  (partial deltas; only with --include-partial-messages, not requested)
 *   <unknown type / unknown block / non-JSON line>               → system_message  (typed; never throws, never dropped)
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveLoginShellPath,
  resolveBinaryOnLoginPath,
  buildChildEnv,
} from "./path.ts";
import {
  makeEvent,
  type CanonicalEvent,
  type EnvelopeContext,
  type Usage,
} from "./canonical.ts";
import {
  ProviderErrorKind,
  toHumanMessage,
  defaultRetryable,
} from "./provider_error.ts";
import { ProviderSpawnError } from "./errors.ts";
import type {
  DetectResult,
  ProviderAdapter,
  SpawnOptions,
  SpawnedProcess,
} from "./types.ts";
import { linesToEvents } from "./transport.ts";

const execFileAsync = promisify(execFile);

export const CLAUDE_ID = "claude";

// ── argv construction (pure + testable) ───────────────────────────────────────

/**
 * Build the headless streaming argv for Claude Code. Pure function: no spawn, no I/O —
 * so it can be asserted exactly in tests. Pinned to Claude Code v2.1.x.
 *
 * Base: `claude -p <prompt> --output-format stream-json --verbose` (print mode; NDJSON
 * event stream; `--verbose` is REQUIRED with stream-json in print mode).
 *
 * Tool gating (Claude has no FS sandbox flag like codex `-s`, so the faithful, non-bypass
 * choices are):
 *   - tools enabled  → --permission-mode acceptEdits. File edits auto-approve in `cwd`;
 *     we deliberately do NOT pass --dangerously-skip-permissions (the full bypass codex
 *     also avoids). Tools requiring broader permission rely on the user's own Claude
 *     settings allowlist.
 *   - tools disabled → --allowedTools "" (pure conversation; the agent is given no tools).
 *
 * MODEL: optional. Omit `--model` to use Claude's account default; pass it only when the
 * caller explicitly chooses one (an unknown model name is rejected at runtime).
 */
export function buildClaudeArgv(opts: SpawnOptions): string[] {
  const argv: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

  // Resume a prior session by id (the handle from a previous run's system/init).
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);

  const toolsEnabled = opts.enableTools ?? true;
  if (toolsEnabled) argv.push("--permission-mode", "acceptEdits");
  else argv.push("--allowedTools", "");

  if (opts.model && opts.model.trim().length > 0) argv.push("--model", opts.model);

  return argv;
}

// ── PATH + binary resolution ─────────────────────────────────────────────────

/** Locate the `claude` binary across the login-shell PATH. Returns null if absent. */
export async function resolveClaudeBinary(): Promise<string | null> {
  return resolveBinaryOnLoginPath("claude");
}

// ── spawn / detect / auth ────────────────────────────────────────────────────

/** Resolve the binary, build the argv, and spawn the headless streaming turn. */
export async function spawnClaude(opts: SpawnOptions): Promise<SpawnedProcess> {
  const bin = await resolveClaudeBinary();
  if (!bin) {
    throw new ProviderSpawnError(
      ProviderErrorKind.CliNotFound,
      toHumanMessage(ProviderErrorKind.CliNotFound),
    );
  }
  const argv = buildClaudeArgv(opts);
  const path = await resolveLoginShellPath();
  try {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv({
        loginPath: path,
        ...(opts.extraPathDirs ? { extraPathDirs: opts.extraPathDirs } : {}),
        ...(opts.envOverrides ? { envOverrides: opts.envOverrides } : {}),
      }),
    }) as SpawnedProcess;
    // The prompt is in the argv; this one-shot adapter sends no stdin. Close it so the
    // CLI doesn't wait on additional input.
    child.stdin.end();
    return child;
  } catch (err) {
    throw new ProviderSpawnError(
      ProviderErrorKind.SpawnFailed,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Detect Claude: found on PATH? version? signed in? */
export async function detectClaude(): Promise<DetectResult> {
  const bin = await resolveClaudeBinary();
  if (!bin) {
    return { id: CLAUDE_ID, found: false, authenticated: false, detail: "not found on PATH" };
  }
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000, encoding: "utf8" });
    version = stdout.trim();
  } catch {
    // best-effort
  }
  const authenticated = await probeClaudeAuth();
  return {
    id: CLAUDE_ID,
    found: true,
    authenticated,
    path: bin,
    version,
    detail: authenticated ? undefined : "sign in required",
  };
}

/**
 * Probe whether Claude is usable. Best-effort + bounded (`claude --version`). A
 * resolvable, version-reporting binary is treated as usable; a hung/failed probe
 * returns false rather than blocking. Never throws.
 */
export async function probeClaudeAuth(): Promise<boolean> {
  const bin = await resolveClaudeBinary();
  if (!bin) return false;
  try {
    await execFileAsync(bin, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── error classification ─────────────────────────────────────────────────────

/**
 * Classify a Claude failure into the shared taxonomy. Claude surfaces errors as a
 * `result` line with `is_error:true` (its `result`/`subtype` carries the message) or as
 * a plain error string. We map by the SAME pattern set as codex/Claude in the engine:
 * rate-limit/overloaded/429 → RateLimited; auth/401/403 → Unauthenticated; else Unknown.
 * Never throws; defaults to Unknown.
 */
export function classifyClaudeError(raw: unknown): {
  errorKind: ProviderErrorKind;
  retryable: boolean;
  message: string;
} {
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    text =
      (typeof o.result === "string" ? o.result : undefined) ??
      (typeof o.message === "string" ? o.message : undefined) ??
      (typeof o.subtype === "string" ? o.subtype : undefined) ??
      JSON.stringify(o);
  }
  const hay = text.toLowerCase();

  let errorKind: ProviderErrorKind;
  if (/rate.?limit|overloaded|too many requests|\b429\b|out_of_credits|usage limit/.test(hay)) {
    errorKind = ProviderErrorKind.RateLimited;
  } else if (
    /unauthor|authentication|invalid.{0,4}api.?key|invalid bearer|please.{0,4}log.?in|sign in|not logged in|\b401\b|\b403\b/.test(hay)
  ) {
    errorKind = ProviderErrorKind.Unauthenticated;
  } else {
    errorKind = ProviderErrorKind.Unknown;
  }
  return { errorKind, retryable: defaultRetryable(errorKind), message: text || toHumanMessage(errorKind) };
}

// ── the parser ───────────────────────────────────────────────────────────────

function mapClaudeUsage(raw: Record<string, unknown> | undefined): Usage {
  const r = raw ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const usage: Usage = {
    inputTokens: num(r.input_tokens) ?? 0,
    outputTokens: num(r.output_tokens) ?? 0,
  };
  const cacheRead = num(r.cache_read_input_tokens);
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  const cacheCreate = num(r.cache_creation_input_tokens);
  if (cacheCreate !== undefined) usage.cacheCreationInputTokens = cacheCreate;
  return usage;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Map ONE native Claude `stream-json` NDJSON line to zero or more canonical events.
 * Never throws on a malformed/unrecognized line — degrades to a typed `system_message`,
 * and never drops anything silently.
 */
export function parseClaude(line: string, ctx: EnvelopeContext): CanonicalEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [makeEvent("system_message", ctx, { text: `[unparsed] ${truncate(trimmed, 500)}` })];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [makeEvent("system_message", ctx, { text: `[unparsed non-object] ${truncate(trimmed, 500)}` })];
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type as string | undefined;

  switch (type) {
    case "system": {
      const subtype = obj.subtype as string | undefined;
      if (subtype === "init") {
        const sessionId = obj.session_id as string | undefined;
        return [makeEvent("system_message", ctx, { text: `Session started (session=${sessionId ?? "unknown"})` })];
      }
      return [makeEvent("system_message", ctx, { text: `[claude system: ${String(subtype)}]` })];
    }
    case "assistant":
      return parseAssistant(obj, ctx);
    case "user":
      return parseUser(obj, ctx);
    case "result":
      return parseResult(obj, ctx);
    case "rate_limit_event": {
      const info = obj.rate_limit_info as Record<string, unknown> | undefined;
      const status = typeof info?.status === "string" ? info.status : "unknown";
      return [makeEvent("session_status", ctx, { status: "rate_limit", detail: status })];
    }
    case "stream_event":
      // Partial-message deltas — only emitted with --include-partial-messages (not requested).
      return [];
    default:
      return [makeEvent("system_message", ctx, { text: `[unmapped type=${String(type)}] ${truncate(trimmed, 400)}` })];
  }
}

/** Fan one `assistant` line's content[] array out to per-block canonical events. */
function parseAssistant(obj: Record<string, unknown>, ctx: EnvelopeContext): CanonicalEvent[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const out: CanonicalEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        out.push(makeEvent("assistant_text", ctx, { text: typeof block.text === "string" ? block.text : "" }));
        break;
      case "thinking":
        out.push(makeEvent("thinking", ctx, { text: typeof block.thinking === "string" ? block.thinking : "" }));
        break;
      case "redacted_thinking":
        out.push(makeEvent("thinking", ctx, { text: "[redacted thinking]" }));
        break;
      case "tool_use":
        out.push(makeEvent("tool_call", ctx, {
          toolName: typeof block.name === "string" ? block.name : "tool",
          callId: typeof block.id === "string" ? block.id : "",
          argsJson: JSON.stringify(block.input ?? {}),
        }));
        break;
      default:
        out.push(makeEvent("system_message", ctx, { text: `[unmapped assistant block type=${String(block.type)}]` }));
    }
  }
  return out;
}

/** A `user` line carries tool_result blocks (paired back to their tool_use by id). */
function parseUser(obj: Record<string, unknown>, ctx: EnvelopeContext): CanonicalEvent[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const out: CanonicalEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "tool_result") {
      out.push(makeEvent("tool_result", ctx, {
        callId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        resultJson: JSON.stringify(block.content ?? null),
        isError: block.is_error === true,
      }));
    }
    // Plain user-text echoes carry no durable signal — skip.
  }
  return out;
}

/** The terminal `result` line → final_result, or provider_error when is_error. */
function parseResult(obj: Record<string, unknown>, ctx: EnvelopeContext): CanonicalEvent[] {
  const isError = obj.is_error === true || obj.subtype === "error";
  if (isError) {
    const { errorKind, retryable, message } = classifyClaudeError(obj);
    return [makeEvent("provider_error", ctx, { errorKind, message, retryable })];
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
  const stopReason = typeof obj.stop_reason === "string" ? obj.stop_reason : null;
  return [makeEvent("final_result", ctx, { costUsd: cost, usage: mapClaudeUsage(usage), stopReason })];
}

// ── the adapter ──────────────────────────────────────────────────────────────

/** The pluggable Claude Code adapter. */
export const claudeAdapter: ProviderAdapter = {
  id: CLAUDE_ID,
  detect: detectClaude,
  probeAuth: probeClaudeAuth,
  spawn: spawnClaude,
  readEvents: (child, ctx) => linesToEvents(child, ctx, parseClaude),
  // No-op: `claude -p` is one-shot (prompt is in the argv); no inbound channel.
  send: () => {},
  parseLine: parseClaude,
};
