/**
 * codex.ts — the Codex provider adapter (the second spawn-and-parse arm).
 *
 * Codex runs headless as:
 *   codex exec --json --skip-git-repo-check
 *        [--dangerously-bypass-approvals-and-sandbox]   (when tools are enabled)
 *        [-m <model>] [-C <cwd>] <prompt>
 *   codex exec resume <thread_id> --json ...            (to resume a thread)
 * emitting newline-delimited JSON (NDJSON) on stdout. This adapter (a) builds that
 * argv + spawns the CLI off the user's resolved login-shell PATH, and (b) maps each
 * native NDJSON event to the canonical event union.
 *
 * Pinned against the installed Codex v0.141.0 (`codex-cli 0.141.0`). The native
 * event shapes below are verified against REAL captures (see
 * test/fixtures/codex/plain_text.jsonl + tool_use.jsonl + NOTES.md), plus the real
 * error JSON-string shape.
 *
 *   {type:"thread.started", thread_id}                      → system_message  ("Session started (thread=<id>)"; thread_id is the resume handle)
 *   {type:"turn.started"}                                   → session_status  {status:"turn_started"}
 *   {type:"item.started",   item.type:"command_execution"}  → tool_call       {toolName:"command_execution", callId:item.id, argsJson}
 *   {type:"item.completed", item.type:"command_execution"}  → tool_result     {callId:item.id, resultJson, isError: exit_code != 0}
 *   {type:"item.started",   item.type:"file_change"}        → tool_call       {toolName:"file_change", callId:item.id, argsJson:{changes}}  (verified live; gpt-5.5's structured file edit)
 *   {type:"item.completed", item.type:"file_change"}        → tool_result     {callId:item.id, resultJson:{changes,status}, isError: status != "completed"}
 *   {type:"item.completed", item.type:"agent_message"}      → assistant_text  {text}
 *   {type:"item.completed", item.type:"reasoning"}          → thinking        {text}  (defensive; field-probe text||summary)
 *   {type:"item.started",   item.type:"agent_message"|...}  → []  (codex sends final items, not token deltas)
 *   {type:"item.updated",   ...}                            → []  (future codex; accounted-for)
 *   {type:"turn.completed", usage}                          → final_result    {costUsd:0 (BYO unmetered), usage, stopReason:"completed"}
 *   {type:"turn.failed", error}  AND  {type:"error", message} → provider_error (classified)
 *   <unknown type / unknown item.type / non-JSON line>      → system_message  (typed; never throws, never dropped)
 *
 * ALTERNATIVE TRANSPORT (intentionally NOT used in P1): Codex also exposes a
 * `codex app-server` JSON-RPC-over-stdio surface (initialize/newConversation/
 * sendUserTurn + streamed notifications, request ids correlating responses). That
 * is the request/response correlator path the widened `ProviderAdapter`
 * (`readEvents` + `send`) deliberately leaves room for — but P1 ships the simpler,
 * already-line-delimited `codex exec --json` path. When the bus later needs an
 * inbound channel (cancel mid-turn), a `codex app-server` adapter implements the
 * SAME interface: `readEvents` as a notification correlator, `send` as the JSON-RPC
 * request channel. No other layer changes.
 *
 * Re-implements the reference's spawn/parse design (INTEGRATION-ANALYSIS.md §2.3).
 * No reference code is imported or shipped.
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

export const CODEX_ID = "codex";

// ── argv construction (pure + testable) ───────────────────────────────────────

/**
 * Build the headless streaming argv for Codex. Pure function: no spawn, no I/O —
 * so it can be asserted exactly in tests. Pinned to Codex v0.141.0.
 *
 * Base: `codex exec --json --skip-git-repo-check` (JSON event stream; do not refuse
 * to run outside a git repo). To RESUME a prior thread we use the subcommand form
 * `codex exec resume <thread_id> --json --skip-git-repo-check` (the thread_id is
 * the handle from a prior run's `thread.started`).
 *
 * Tool gating (codex 0.141.0's `exec` has NO `-a/--ask-for-approval` — it errors
 * "unexpected argument '-a'". Its real knob is `-s`):
 *   - tools enabled  → -s workspace-write. Codex runs SANDBOXED to the workspace: it can
 *     read + write inside `cwd` but can't autonomously touch the broader system. A safe
 *     default for running another agent's output. (We deliberately do NOT use
 *     --dangerously-bypass-approvals-and-sandbox, which removes the sandbox entirely.)
 *   - tools disabled → -s read-only (pure conversation; no tool side effects).
 *
 * MODEL: `opts.model` is OPTIONAL. We omit `-m` when no model is given so Codex uses its
 * account default (which works), and only pass `-m` when the caller explicitly chooses a
 * model — because passing an UNSUPPORTED model name is rejected at runtime (e.g. named
 * `gpt-5*` models are "not supported when using Codex with a ChatGPT account").
 */
export function buildCodexArgv(opts: SpawnOptions): string[] {
  const argv: string[] = ["exec"];
  // Resume subcommand form, when resuming a prior thread.
  if (opts.resumeSessionId) argv.push("resume", opts.resumeSessionId);

  argv.push("--json", "--skip-git-repo-check");

  // Sandbox policy IS the gating knob on `codex exec` (no `-a` here): write-in-workspace
  // when tools are enabled, read-only for pure conversation.
  const toolsEnabled = opts.enableTools ?? true;
  argv.push("-s", toolsEnabled ? "workspace-write" : "read-only");

  // Optional model — omit to use codex's account default (see docstring).
  if (opts.model && opts.model.trim().length > 0) argv.push("-m", opts.model);
  argv.push("-C", opts.cwd);

  // The prompt is the trailing positional argument.
  argv.push(opts.prompt);
  return argv;
}

// ── PATH + binary resolution ─────────────────────────────────────────────────

/** Locate the `codex` binary across the login-shell PATH. Returns null if absent. */
export async function resolveCodexBinary(): Promise<string | null> {
  return resolveBinaryOnLoginPath("codex");
}

// ── spawn / detect / auth ────────────────────────────────────────────────────

/** Resolve the binary, build the argv, and spawn the headless streaming turn. */
export async function spawnCodex(opts: SpawnOptions): Promise<SpawnedProcess> {
  const bin = await resolveCodexBinary();
  if (!bin) {
    throw new ProviderSpawnError(
      ProviderErrorKind.CliNotFound,
      toHumanMessage(ProviderErrorKind.CliNotFound),
    );
  }
  const argv = buildCodexArgv(opts); // may throw ProviderSpawnError (missing model)
  const path = await resolveLoginShellPath();
  try {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // P2.2: prepend the basics-store wrapper dir to PATH + inject BASICS_STORE_DB
      // (and any other env overrides) via the shared builder so both adapters match.
      env: buildChildEnv({
        loginPath: path,
        ...(opts.extraPathDirs ? { extraPathDirs: opts.extraPathDirs } : {}),
        ...(opts.envOverrides ? { envOverrides: opts.envOverrides } : {}),
      }),
    }) as SpawnedProcess;
    // The prompt is in the argv; this one-shot JSONL adapter sends no stdin. Close
    // it or `codex exec` blocks forever ("reading additional input from stdin").
    // (A future `codex app-server` adapter keeps stdin open and writes via send().)
    child.stdin.end();
    return child;
  } catch (err) {
    throw new ProviderSpawnError(
      ProviderErrorKind.SpawnFailed,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Detect Codex: found on PATH? version? signed in? */
export async function detectCodex(): Promise<DetectResult> {
  const bin = await resolveCodexBinary();
  if (!bin) {
    return {
      id: CODEX_ID,
      found: false,
      authenticated: false,
      detail: "not found on PATH",
    };
  }
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout: 5000,
      encoding: "utf8",
    });
    version = stdout.trim();
  } catch {
    // version probe is best-effort
  }
  const authenticated = await probeCodexAuth();
  return {
    id: CODEX_ID,
    found: true,
    authenticated,
    path: bin,
    version,
    detail: authenticated ? undefined : "sign in required",
  };
}

/**
 * Probe whether Codex is signed in. Best-effort + bounded (`codex --version`). In
 * P1 we treat a resolvable, version-reporting binary as usable; a precise auth
 * probe is refined alongside the connect-your-agent picker in Prompt 5. Never
 * throws; a hung/failed probe returns false rather than blocking.
 */
export async function probeCodexAuth(): Promise<boolean> {
  const bin = await resolveCodexBinary();
  if (!bin) return false;
  try {
    await execFileAsync(bin, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── error classification ─────────────────────────────────────────────────────

const CODEX_ERROR_TYPE_KIND: Record<string, ProviderErrorKind> = {
  rate_limit_error: ProviderErrorKind.RateLimited,
  overloaded_error: ProviderErrorKind.RateLimited,
  overloaded: ProviderErrorKind.RateLimited,
  authentication_error: ProviderErrorKind.Unauthenticated,
  permission_error: ProviderErrorKind.Unauthenticated,
};

/**
 * Classify a Codex error. Codex's error `message` is itself a JSON STRING, e.g.
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}
 * We JSON.parse it (guarded), then map by the SAME taxonomy as Claude:
 *   status 429 OR error.type rate_limit/overloaded → RateLimited (retryable)
 *   status 401/403 OR authentication/permission     → Unauthenticated
 *   status >= 500                                    → Unknown (retryable)
 *   else                                            → Unknown (not retryable)
 *
 * `raw` may be the JSON string itself, or an already-parsed object (e.g. the
 * `error` object on a `turn.failed`). Never throws; defaults to Unknown.
 */
export function classifyCodexError(raw: unknown): {
  errorKind: ProviderErrorKind;
  retryable: boolean;
  message: string;
} {
  // Resolve to an object we can probe.
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      } else {
        obj = { message: raw };
      }
    } catch {
      obj = { message: raw };
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }

  // Codex's `turn.failed` nests the error one level deeper than `error`: its
  // `error` object's `.message` is itself a JSON-encoded error string. Descend into
  // it so we read the real status/type AND surface a CLEAN human message (e.g.
  // "rl") rather than a raw JSON blob in provider_error.message.
  if (typeof obj.message === "string") {
    try {
      const inner = JSON.parse(obj.message);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        obj = inner as Record<string, unknown>;
      }
    } catch {
      /* message is a plain human string — keep it as-is */
    }
  }

  // The inner `error` object may itself be a JSON string (defensive) or an object.
  let errObj: Record<string, unknown> | undefined;
  const rawErr = obj.error;
  if (typeof rawErr === "string") {
    try {
      const p = JSON.parse(rawErr);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        errObj = p as Record<string, unknown>;
      }
    } catch {
      // leave undefined; rawErr was just a string message
    }
  } else if (rawErr && typeof rawErr === "object" && !Array.isArray(rawErr)) {
    errObj = rawErr as Record<string, unknown>;
  }

  const errType =
    (typeof errObj?.type === "string" ? errObj.type : undefined) ??
    (typeof obj.type === "string" && obj.type !== "error" ? obj.type : undefined);

  const statusRaw = obj.status ?? (errObj?.status as unknown) ?? obj.statusCode;
  const httpStatus =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && /^\d{3}$/.test(statusRaw)
        ? Number(statusRaw)
        : undefined;

  const text =
    (typeof errObj?.message === "string" ? errObj.message : undefined) ??
    (typeof obj.message === "string" ? obj.message : undefined) ??
    "";

  let errorKind: ProviderErrorKind;
  if (errType && CODEX_ERROR_TYPE_KIND[errType]) {
    errorKind = CODEX_ERROR_TYPE_KIND[errType];
  } else if (httpStatus === 429) {
    errorKind = ProviderErrorKind.RateLimited;
  } else if (httpStatus === 401 || httpStatus === 403) {
    errorKind = ProviderErrorKind.Unauthenticated;
  } else if (httpStatus !== undefined && httpStatus >= 500) {
    return {
      errorKind: ProviderErrorKind.Unknown,
      retryable: true,
      message: text || toHumanMessage(ProviderErrorKind.Unknown),
    };
  } else {
    const hay = `${errType ?? ""} ${text}`.toLowerCase();
    if (/rate.?limit|overloaded|too many requests|\b429\b/.test(hay)) {
      errorKind = ProviderErrorKind.RateLimited;
    } else if (
      /unauthor|authentication|invalid.{0,4}api.?key|invalid bearer|please.{0,4}log.?in|sign in|\b401\b|\b403\b/.test(
        hay,
      )
    ) {
      errorKind = ProviderErrorKind.Unauthenticated;
    } else {
      errorKind = ProviderErrorKind.Unknown;
    }
  }

  return {
    errorKind,
    retryable: defaultRetryable(errorKind),
    message: text || toHumanMessage(errorKind),
  };
}

// ── the parser ───────────────────────────────────────────────────────────────

function mapUsage(raw: Record<string, unknown> | undefined): Usage {
  const r = raw ?? {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  const usage: Usage = {
    inputTokens: num(r.input_tokens) ?? 0,
    outputTokens: num(r.output_tokens) ?? 0,
  };
  const cacheRead = num(r.cached_input_tokens);
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  return usage;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Map ONE native Codex `codex exec --json` NDJSON line to zero or more canonical
 * events. Never throws on a malformed/unrecognized line — degrades to a typed
 * `system_message` (provider-neutral "[unparsed ...]" / "[unmapped ...]"), and
 * never drops anything silently.
 */
export function parseCodex(line: string, ctx: EnvelopeContext): CanonicalEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [
      makeEvent("system_message", ctx, {
        text: `[unparsed] ${truncate(trimmed, 500)}`,
      }),
    ];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [
      makeEvent("system_message", ctx, {
        text: `[unparsed non-object] ${truncate(trimmed, 500)}`,
      }),
    ];
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type as string | undefined;

  switch (type) {
    case "thread.started": {
      const threadId = obj.thread_id as string | undefined;
      // Provider-neutral text; thread_id is the resume handle (like Claude's session_id).
      return [
        makeEvent("system_message", ctx, {
          text: `Session started (thread=${threadId ?? "unknown"})`,
        }),
      ];
    }
    case "turn.started":
      return [makeEvent("session_status", ctx, { status: "turn_started" })];
    case "item.started":
      return parseItemStarted(obj, ctx);
    case "item.completed":
      return parseItemCompleted(obj, ctx);
    case "item.updated":
      // Future codex token-style updates — accounted-for, not surfaced in P1.
      return [];
    case "turn.completed": {
      const usage = obj.usage as Record<string, unknown> | undefined;
      return [
        makeEvent("final_result", ctx, {
          // costUsd:0 — BYO subscription is unmetered; cost is not reported by codex.
          costUsd: 0,
          usage: mapUsage(usage),
          stopReason: "completed",
        }),
      ];
    }
    case "turn.failed": {
      const { errorKind, retryable, message } = classifyCodexError(obj.error);
      return [makeEvent("provider_error", ctx, { errorKind, message, retryable })];
    }
    case "error": {
      const { errorKind, retryable, message } = classifyCodexError(obj.message);
      return [makeEvent("provider_error", ctx, { errorKind, message, retryable })];
    }
    default:
      return [
        makeEvent("system_message", ctx, {
          text: `[unmapped type=${String(type)}] ${truncate(trimmed, 400)}`,
        }),
      ];
  }
}

function parseItemStarted(
  obj: Record<string, unknown>,
  ctx: EnvelopeContext,
): CanonicalEvent[] {
  const item = obj.item as Record<string, unknown> | undefined;
  const itemType = item?.type as string | undefined;
  switch (itemType) {
    case "command_execution": {
      return [
        makeEvent("tool_call", ctx, {
          toolName: "command_execution",
          callId: (item?.id as string | undefined) ?? "",
          argsJson: JSON.stringify({ command: item?.command }),
        }),
      ];
    }
    case "file_change": {
      // Codex's structured file-edit tool (verified live: gpt-5.5 uses this instead
      // of a shell `command_execution` to create/edit files). It's a tool → tool_call.
      return [
        makeEvent("tool_call", ctx, {
          toolName: "file_change",
          callId: (item?.id as string | undefined) ?? "",
          argsJson: JSON.stringify({ changes: item?.changes ?? [] }),
        }),
      ];
    }
    // Codex sends FINAL items (no token deltas), so a started agent_message /
    // reasoning carries no content yet — accounted-for, no event.
    case "agent_message":
    case "reasoning":
      return [];
    default:
      return [
        makeEvent("system_message", ctx, {
          text: `[unmapped item.started item.type=${String(itemType)}]`,
        }),
      ];
  }
}

function parseItemCompleted(
  obj: Record<string, unknown>,
  ctx: EnvelopeContext,
): CanonicalEvent[] {
  const item = obj.item as Record<string, unknown> | undefined;
  const itemType = item?.type as string | undefined;
  switch (itemType) {
    case "command_execution": {
      const exitCode = item?.exit_code as number | null | undefined;
      return [
        makeEvent("tool_result", ctx, {
          callId: (item?.id as string | undefined) ?? "",
          resultJson: JSON.stringify({
            aggregated_output: item?.aggregated_output,
            exit_code: item?.exit_code ?? null,
            status: item?.status,
          }),
          isError: exitCode != null && exitCode !== 0,
        }),
      ];
    }
    case "file_change": {
      const status = item?.status as string | undefined;
      return [
        makeEvent("tool_result", ctx, {
          callId: (item?.id as string | undefined) ?? "",
          resultJson: JSON.stringify({ changes: item?.changes ?? [], status }),
          isError: status != null && status !== "completed",
        }),
      ];
    }
    case "agent_message": {
      return [
        makeEvent("assistant_text", ctx, {
          text: (item?.text as string | undefined) ?? "",
        }),
      ];
    }
    case "reasoning": {
      // Defensive: not seen in the live captures. Field-probe text || summary.
      const text =
        (typeof item?.text === "string" ? item.text : undefined) ??
        (typeof item?.summary === "string" ? item.summary : undefined) ??
        "";
      return [makeEvent("thinking", ctx, { text })];
    }
    case "error": {
      // A NON-FATAL codex warning, e.g. "Model metadata for `x` not found. Defaulting to
      // fallback ...". Surface the real human message as a system_message rather than the
      // internal "[unmapped ...]" marker (the fatal error path is the native `error` +
      // `turn.failed` pair, which still maps to a typed provider_error).
      const text =
        (typeof item?.message === "string" ? item.message : undefined) ?? "[codex warning]";
      return [makeEvent("system_message", ctx, { text })];
    }
    default:
      return [
        makeEvent("system_message", ctx, {
          text: `[unmapped item.completed item.type=${String(itemType)}]`,
        }),
      ];
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────

/** The pluggable Codex adapter. */
export const codexAdapter: ProviderAdapter = {
  id: CODEX_ID,
  detect: detectCodex,
  probeAuth: probeCodexAuth,
  spawn: spawnCodex,
  // readEvents IS the contract; parseCodex is its line-delimited impl detail.
  readEvents: (child, ctx) => linesToEvents(child, ctx, parseCodex),
  // No-op: `codex exec --json` is one-shot (prompt is in the argv); no inbound channel.
  // The inbound channel lives on the `codex app-server` path (see header), not here.
  send: () => {},
  parseLine: parseCodex,
};
