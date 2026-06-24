/**
 * generic.ts — the CONFIG-DRIVEN "bring your own CLI" provider adapter (Conduit).
 *
 * The hand-written adapters (claude.ts, codex.ts) follow the studied reference's
 * design: adding a provider is hand-written spawn + parse code by design
 * (INTEGRATION-ANALYSIS.md §2.3 — "adding a brand-new runtime is the spawn +
 * parse layers, not config; 'any ACP agent' is aspirational"). That is correct for
 * a provider whose native stream needs bespoke logic (Claude's streaming-delta
 * accumulation; Codex's double-JSON-encoded error nesting).
 *
 * This module adds the OTHER half: a DECLARATIVE adapter for the large class of
 * agent CLIs that are already line-delimited JSON (NDJSON/JSONL) on stdout and map
 * cleanly to the canonical union with field extraction alone. Such a CLI is brought
 * online by writing a {@link GenericCliSpec} — no TypeScript, no `match` arm — and
 * `defineGenericCli(spec)` returns a fully-formed {@link ProviderAdapter} that the
 * registry treats identically to the hand-written ones.
 *
 * It deliberately reuses the existing seams, so a generic provider is a first-class
 * citizen, not a parallel path:
 *   • PATH + env resolution  → ./path.ts (resolveLoginShellPath, buildChildEnv)
 *   • the line→event fold     → ./transport.ts (linesToEvents)
 *   • event construction      → makeEvent (the ONLY way to build a canonical event)
 *   • error taxonomy          → ProviderErrorKind + toHumanMessage + defaultRetryable
 *   • spawn errors            → ProviderSpawnError (shared with claude/codex)
 *
 * SCOPE (matches the P1 line/JSONL transport): a generic spec describes a one-shot,
 * line-delimited, prompt-in-argv-or-stdin CLI. A request/response JSON-RPC-over-stdio
 * provider (`codex app-server`, Hermes-over-ACP) is still a hand-written `readEvents`
 * correlator — that is the deliberately-left-open seam in types.ts's FORWARD-NOTE,
 * not something a declarative line spec should pretend to cover.
 *
 * Re-implements the reference's declarative CLI-registry idea (Houston's
 * `cli-deps.json` pins binaries; this extends the idea to also declare the PARSE
 * mapping, which Houston does NOT — there it is hand-written `match provider.id()`).
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

// ── the spec types (THIS is the "bring your own CLI" contract) ─────────────────

/**
 * How the user's prompt reaches the CLI.
 *   - "positional" → appended as the trailing argv positional (Claude, Codex).
 *   - "flag"       → passed via a flag, e.g. `--prompt <text>` (set `flag`).
 *   - "stdin"      → written to the child's stdin, which is then closed.
 */
export interface PromptDelivery {
  mode: "positional" | "flag" | "stdin";
  /** The flag name when `mode === "flag"` (e.g. "--prompt", "-p"). */
  flag?: string;
}

/** A flag that carries a single value when a corresponding option is present. */
export interface ValueFlag {
  /** The flag name, e.g. "--model" or "-m". */
  flag: string;
  /** When true, spawning without the value is a typed SpawnFailed (e.g. Codex's model). */
  required?: boolean;
}

/** How the CLI resumes a prior session — a trailing flag OR a leading subcommand. */
export interface ResumeForm {
  /** Flag form: `… --resume <id>` (Claude). */
  flag?: string;
  /** Subcommand form: `<leading> resume <id> …` (Codex `exec resume <id>`). Inserted
   *  between `leading` and `flags`. The id is appended after these tokens. */
  subcommand?: string[];
}

/** The declarative argv recipe. Order produced:
 *  `[...leading, (resume subcommand+id)?, ...flags, (resume flag+id)?, tools?, model?, cwd?, systemPromptFile?, prompt?]`. */
export interface GenericArgvSpec {
  /** Subcommand prefix that must lead the argv, e.g. ["exec"] for Codex, [] for Claude. */
  leading?: string[];
  /** Static flags that follow the leading subcommand, e.g. ["--json","--skip-git-repo-check"]. */
  flags?: string[];
  /** Optional model flag. */
  model?: ValueFlag;
  /** Optional working-dir flag (some CLIs take cwd as a flag in addition to the spawn cwd). */
  cwd?: { flag: string };
  /** Optional system-prompt-file flag (engine-assembled prompt file). */
  systemPromptFile?: { flag: string };
  /** How to resume a prior session id. */
  resume?: ResumeForm;
  /** Args appended when tools are enabled (the autonomous/bypass arm). */
  toolsEnabled?: string[];
  /** Args appended when tools are disabled. */
  toolsDisabled?: string[];
  /** How the prompt is delivered. */
  prompt: PromptDelivery;
}

/** A value pulled out of one parsed native line, for a canonical payload field. */
export type FieldSource =
  /** Read the primitive at a dotted path (e.g. "item.text", "usage.input_tokens"). */
  | { path: string }
  /** JSON.stringify the value at a dotted path (for `argsJson`/`resultJson`). */
  | { jsonPath: string }
  /** A literal constant. */
  | { const: string | number | boolean }
  /** Interpolate dotted paths into a template, e.g. "Session started (thread={thread_id})". */
  | { template: string };

/** The canonical kinds a declarative line spec may emit. */
export type GenericEmitKind =
  | "assistant_text"
  | "assistant_text_streaming"
  | "thinking"
  | "thinking_streaming"
  | "tool_call"
  | "tool_result"
  | "system_message"
  | "session_status"
  | "context_compacted"
  | "final_result"
  | "provider_error";

/** One canonical event to emit when a rule matches. */
export interface GenericEmit {
  kind: GenericEmitKind;
  /** Field extraction per canonical payload field. Missing fields use safe defaults. */
  fields?: Record<string, FieldSource>;
  /** For `provider_error`: classify the value at this dotted path (HTTP status + regex). */
  classifyFrom?: string;
  /** For `final_result`: dotted path to a usage-ish object (token counts mapped generically). */
  usagePath?: string;
}

/** A single mapping rule: AND of field==value conditions → ordered emits. First match wins. */
export interface GenericRule {
  /** Conditions (all must hold). Empty array = catch-all. Compared as strings. */
  match: { field: string; equals: string }[];
  /** Events to emit, in order. Empty = intentionally swallow (e.g. token-delta frames). */
  emit: GenericEmit[];
}

/** The line→event mapping. */
export interface GenericMapping {
  /** Ordered rules; the FIRST whose `match` fully holds wins. */
  rules: GenericRule[];
  /** On no match: emit a typed `system_message` ("[unmapped] …") so nothing drops. Default true. */
  fallback?: boolean;
}

/** A regex→kind rule for classifying error text/stderr. */
export interface GenericErrorRule {
  /** A regex (string) tested case-insensitively against the candidate text. */
  match: string;
  kind: ProviderErrorKind;
}

/**
 * THE "bring your own CLI" spec. Hand it to {@link defineGenericCli} and you have a
 * provider adapter the engine drives exactly like Claude or Codex.
 */
export interface GenericCliSpec {
  /** Stable provider id, e.g. "aider", "opencode", "my-cli". */
  id: string;
  /** Binary name resolved on the login-shell PATH (e.g. "aider"). */
  binary: string;
  /** The argv recipe. */
  argv: GenericArgvSpec;
  /** The line→event mapping. */
  mapping: GenericMapping;
  /** Dotted path to a line's discriminant field (default "type"). */
  discriminator?: string;
  /** Optional version-probe args (default ["--version"]). */
  versionArgs?: string[];
  /** Optional error-classification regex rules (consulted before the HTTP-status heuristic). */
  errorRules?: GenericErrorRule[];
  /** Human-facing display name for the picker (defaults to `id`). */
  displayName?: string;
}

// ── dotted-path + coercion helpers ─────────────────────────────────────────────

/** Resolve a dotted path ("a.b.c") against a parsed object. Returns undefined if any hop misses. */
export function getPath(obj: unknown, path: string): unknown {
  if (path.length === 0) return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
}

/** Interpolate `{a.b}` dotted-path references in a template against the parsed object. */
function interpolate(template: string, obj: unknown): string {
  return template.replace(/\{([^}]+)\}/g, (_m, p1: string) => {
    const v = getPath(obj, p1.trim());
    return asString(v) ?? "";
  });
}

/** Resolve a {@link FieldSource} against a parsed line. Returns a JSON primitive or undefined. */
function resolveField(
  src: FieldSource | undefined,
  obj: unknown,
): string | number | boolean | undefined {
  if (!src) return undefined;
  if ("const" in src) return src.const;
  if ("template" in src) return interpolate(src.template, obj);
  if ("jsonPath" in src) {
    const v = getPath(obj, src.jsonPath);
    return v === undefined ? undefined : JSON.stringify(v);
  }
  // { path }
  return asString(getPath(obj, src.path));
}

function field(emit: GenericEmit, name: string, obj: unknown): string | undefined {
  return asString(resolveField(emit.fields?.[name], obj));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ── error classification (generic; reuses the shared taxonomy) ─────────────────

const KNOWN_ERROR_TYPE_KIND: Record<string, ProviderErrorKind> = {
  rate_limit_error: ProviderErrorKind.RateLimited,
  overloaded_error: ProviderErrorKind.RateLimited,
  overloaded: ProviderErrorKind.RateLimited,
  authentication_error: ProviderErrorKind.Unauthenticated,
  permission_error: ProviderErrorKind.Unauthenticated,
};

/**
 * Classify an arbitrary error value into the shared taxonomy. Mirrors the Claude/Codex
 * heuristic generically: unwrap a JSON-string-encoded error, read an HTTP `status`,
 * an `error.type`, and a message; consult any spec `errorRules`; default to Unknown.
 * Never throws.
 */
export function classifyGenericError(
  raw: unknown,
  rules?: GenericErrorRule[],
): { errorKind: ProviderErrorKind; retryable: boolean; message: string } {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      obj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { message: raw };
    } catch {
      obj = { message: raw };
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }

  // Unwrap one level of JSON-string-encoded `.message` (Codex-style double encoding).
  if (typeof obj.message === "string") {
    try {
      const inner: unknown = JSON.parse(obj.message);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        obj = inner as Record<string, unknown>;
      }
    } catch {
      /* plain human message — keep as-is */
    }
  }

  const errObj =
    obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)
      ? (obj.error as Record<string, unknown>)
      : undefined;

  const errType =
    (typeof errObj?.type === "string" ? errObj.type : undefined) ??
    (typeof obj.type === "string" && obj.type !== "error" ? obj.type : undefined);

  const httpStatus =
    asNumber(obj.status) ?? asNumber(errObj?.status) ?? asNumber(obj.statusCode);

  const text =
    (typeof errObj?.message === "string" ? errObj.message : undefined) ??
    (typeof obj.message === "string" ? obj.message : undefined) ??
    "";

  // 1) spec-provided regex rules win first.
  const hay = `${errType ?? ""} ${text}`;
  if (rules) {
    for (const rule of rules) {
      try {
        if (new RegExp(rule.match, "i").test(hay)) {
          return {
            errorKind: rule.kind,
            retryable: defaultRetryable(rule.kind),
            message: text || toHumanMessage(rule.kind),
          };
        }
      } catch {
        /* a bad regex in a spec must never crash a turn */
      }
    }
  }

  // 2) known error-type token, then HTTP status, then a built-in regex heuristic.
  let errorKind: ProviderErrorKind;
  if (errType && KNOWN_ERROR_TYPE_KIND[errType]) {
    errorKind = KNOWN_ERROR_TYPE_KIND[errType];
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
  } else if (/rate.?limit|overloaded|too many requests|\b429\b/i.test(hay)) {
    errorKind = ProviderErrorKind.RateLimited;
  } else if (
    /unauthor|authentication|invalid.{0,4}api.?key|invalid bearer|please.{0,4}log.?in|sign in|\b401\b|\b403\b/i.test(
      hay,
    )
  ) {
    errorKind = ProviderErrorKind.Unauthenticated;
  } else {
    errorKind = ProviderErrorKind.Unknown;
  }

  return {
    errorKind,
    retryable: defaultRetryable(errorKind),
    message: text || toHumanMessage(errorKind),
  };
}

// ── usage mapping ──────────────────────────────────────────────────────────────

function mapUsage(raw: unknown): Usage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: asNumber(r.input_tokens) ?? asNumber(r.inputTokens) ?? 0,
    outputTokens: asNumber(r.output_tokens) ?? asNumber(r.outputTokens) ?? 0,
  };
  const cacheRead = asNumber(r.cached_input_tokens) ?? asNumber(r.cacheReadInputTokens);
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  return usage;
}

// ── the declarative parser ──────────────────────────────────────────────────────

/** Build one canonical event from a matched emit. Always uses makeEvent (the only path). */
function emitToEvent(
  emit: GenericEmit,
  obj: unknown,
  ctx: EnvelopeContext,
  spec: GenericCliSpec,
): CanonicalEvent {
  switch (emit.kind) {
    case "assistant_text":
      return makeEvent("assistant_text", ctx, { text: field(emit, "text", obj) ?? "" });
    case "assistant_text_streaming":
      return makeEvent("assistant_text_streaming", ctx, {
        deltaText: field(emit, "deltaText", obj) ?? "",
      });
    case "thinking":
      return makeEvent("thinking", ctx, { text: field(emit, "text", obj) ?? "" });
    case "thinking_streaming":
      return makeEvent("thinking_streaming", ctx, {
        deltaText: field(emit, "deltaText", obj) ?? "",
      });
    case "tool_call":
      return makeEvent("tool_call", ctx, {
        toolName: field(emit, "toolName", obj) ?? "tool",
        callId: field(emit, "callId", obj) ?? "",
        argsJson: field(emit, "argsJson", obj) ?? "{}",
      });
    case "tool_result": {
      const isErrRaw = resolveField(emit.fields?.["isError"], obj);
      return makeEvent("tool_result", ctx, {
        callId: field(emit, "callId", obj) ?? "",
        resultJson: field(emit, "resultJson", obj) ?? "null",
        isError: isErrRaw === true || isErrRaw === "true",
      });
    }
    case "system_message":
      return makeEvent("system_message", ctx, { text: field(emit, "text", obj) ?? "" });
    case "session_status": {
      const detail = field(emit, "detail", obj);
      return makeEvent("session_status", ctx, {
        status: field(emit, "status", obj) ?? "status",
        ...(detail !== undefined ? { detail } : {}),
      });
    }
    case "context_compacted": {
      const reason = field(emit, "reason", obj);
      return makeEvent("context_compacted", ctx, {
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    case "final_result": {
      const usageRaw = emit.usagePath ? getPath(obj, emit.usagePath) : undefined;
      const costStr = field(emit, "costUsd", obj);
      const stop = field(emit, "stopReason", obj);
      return makeEvent("final_result", ctx, {
        // BYO subscription is unmetered by default → 0 unless the CLI reports a cost.
        costUsd: costStr !== undefined ? Number(costStr) || 0 : 0,
        usage: mapUsage(usageRaw),
        stopReason: stop ?? "completed",
      });
    }
    case "provider_error": {
      const src = emit.classifyFrom ? getPath(obj, emit.classifyFrom) : obj;
      const { errorKind, retryable, message } = classifyGenericError(
        src,
        spec.errorRules,
      );
      return makeEvent("provider_error", ctx, { errorKind, message, retryable });
    }
    default: {
      // Exhaustiveness guard: a new GenericEmitKind without a branch fails to compile.
      const _never: never = emit.kind;
      return makeEvent("system_message", ctx, { text: `[unhandled emit ${String(_never)}]` });
    }
  }
}

/**
 * Map ONE native line to zero or more canonical events, per the spec's mapping.
 * Never throws on a malformed/unrecognized line — degrades to a typed
 * `system_message` ("[unparsed]"/"[unmapped]"), and never drops silently.
 */
export function parseGenericLine(
  spec: GenericCliSpec,
  line: string,
  ctx: EnvelopeContext,
): CanonicalEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [makeEvent("system_message", ctx, { text: `[unparsed] ${truncate(trimmed, 500)}` })];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [
      makeEvent("system_message", ctx, {
        text: `[unparsed non-object] ${truncate(trimmed, 500)}`,
      }),
    ];
  }

  for (const rule of spec.mapping.rules) {
    const matched = rule.match.every(
      (c) => asString(getPath(parsed, c.field)) === c.equals,
    );
    if (!matched) continue;
    // First fully-matching rule wins. An empty emit list intentionally swallows the line.
    return rule.emit.map((e) => emitToEvent(e, parsed, ctx, spec));
  }

  if (spec.mapping.fallback === false) return [];
  const disc = asString(getPath(parsed, spec.discriminator ?? "type"));
  return [
    makeEvent("system_message", ctx, {
      text: `[unmapped ${spec.discriminator ?? "type"}=${String(disc)}] ${truncate(trimmed, 400)}`,
    }),
  ];
}

// ── argv construction (pure + testable) ─────────────────────────────────────────

/** Build the headless argv for a generic spec. Pure: no spawn, no I/O. May throw ProviderSpawnError. */
export function buildGenericArgv(spec: GenericCliSpec, opts: SpawnOptions): string[] {
  const a = spec.argv;
  const argv: string[] = [...(a.leading ?? [])];

  // Resume — subcommand form goes right after the leading subcommand; flag form trails the flags.
  if (opts.resumeSessionId && a.resume?.subcommand) {
    argv.push(...a.resume.subcommand, opts.resumeSessionId);
  }
  argv.push(...(a.flags ?? []));
  if (opts.resumeSessionId && a.resume?.flag) {
    argv.push(a.resume.flag, opts.resumeSessionId);
  }

  // Tool-gating (mode) args precede model/cwd, mirroring the hand-written codex recipe.
  const toolsEnabled = opts.enableTools ?? true;
  if (toolsEnabled && a.toolsEnabled) argv.push(...a.toolsEnabled);
  if (!toolsEnabled && a.toolsDisabled) argv.push(...a.toolsDisabled);

  // Model — required-but-absent is a typed spawn error (e.g. Codex's retired default).
  if (a.model) {
    if ((!opts.model || opts.model.trim().length === 0) && a.model.required) {
      throw new ProviderSpawnError(
        ProviderErrorKind.SpawnFailed,
        `${spec.id} requires an explicit model (opts.model).`,
      );
    }
    if (opts.model) argv.push(a.model.flag, opts.model);
  }

  if (a.cwd) argv.push(a.cwd.flag, opts.cwd);
  if (a.systemPromptFile && opts.systemPromptFile) {
    argv.push(a.systemPromptFile.flag, opts.systemPromptFile);
  }

  // Prompt — positional (trailing) or via flag. stdin-delivered prompts add no argv.
  if (a.prompt.mode === "positional") {
    argv.push(opts.prompt);
  } else if (a.prompt.mode === "flag" && a.prompt.flag) {
    argv.push(a.prompt.flag, opts.prompt);
  }

  return argv;
}

// ── the factory ──────────────────────────────────────────────────────────────

/**
 * Turn a {@link GenericCliSpec} into a {@link ProviderAdapter}. The returned adapter
 * resolves the binary on the login-shell PATH, builds argv from the spec, spawns the
 * one-shot streaming turn, and folds stdout lines through the spec's declarative
 * mapping — using the SAME `linesToEvents`/`makeEvent`/PATH seams as the hand-written
 * adapters, so the registry, bus, and renderer treat it identically.
 */
export function defineGenericCli(spec: GenericCliSpec): ProviderAdapter {
  const parseLine = (line: string, ctx: EnvelopeContext): CanonicalEvent[] =>
    parseGenericLine(spec, line, ctx);

  async function resolveBinary(): Promise<string | null> {
    return resolveBinaryOnLoginPath(spec.binary);
  }

  async function detect(): Promise<DetectResult> {
    const bin = await resolveBinary();
    if (!bin) {
      return { id: spec.id, found: false, authenticated: false, detail: "not found on PATH" };
    }
    let version: string | undefined;
    try {
      const { stdout } = await execFileAsync(bin, spec.versionArgs ?? ["--version"], {
        timeout: 5000,
        encoding: "utf8",
      });
      version = stdout.trim();
    } catch {
      /* version probe is best-effort */
    }
    const authenticated = await probeAuth();
    return {
      id: spec.id,
      found: true,
      authenticated,
      path: bin,
      ...(version !== undefined ? { version } : {}),
      ...(authenticated ? {} : { detail: "sign in required" }),
    };
  }

  async function probeAuth(): Promise<boolean> {
    const bin = await resolveBinary();
    if (!bin) return false;
    try {
      await execFileAsync(bin, spec.versionArgs ?? ["--version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async function spawnTurn(opts: SpawnOptions): Promise<SpawnedProcess> {
    const bin = await resolveBinary();
    if (!bin) {
      throw new ProviderSpawnError(
        ProviderErrorKind.CliNotFound,
        toHumanMessage(ProviderErrorKind.CliNotFound),
      );
    }
    const argv = buildGenericArgv(spec, opts); // may throw ProviderSpawnError (required model)
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
      // Deliver the prompt over stdin if configured; otherwise close stdin so a
      // one-shot CLI does not block waiting for input (same discipline as codex.ts).
      if (spec.argv.prompt.mode === "stdin") {
        child.stdin.write(opts.prompt);
      }
      child.stdin.end();
      return child;
    } catch (err) {
      throw new ProviderSpawnError(
        ProviderErrorKind.SpawnFailed,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    id: spec.id,
    detect,
    probeAuth,
    spawn: spawnTurn,
    readEvents: (child, ctx) => linesToEvents(child, ctx, parseLine),
    // One-shot line/JSONL adapter — prompt is in the argv/stdin, no inbound channel.
    send: () => {},
    parseLine,
  };
}
