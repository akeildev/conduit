/**
 * types.ts — the `ProviderAdapter` interface that makes providers pluggable.
 *
 * Re-implements the design behind the reference's `houston-terminal-manager` /
 * `session_dispatch.rs` (INTEGRATION-ANALYSIS.md §2.3): adding a provider is
 * hand-written spawn + parse code, by design — not config.
 *
 * ┌─ FORWARD-NOTE (Prompt 2 widens this; the widening must be ADDITIVE) ────────┐
 * │ In Phase 1 the adapter contract exposes `parseLine(line, ctx)` because both  │
 * │ Phase-1 providers are line-delimited NDJSON on stdout (Claude `stream-json`; │
 * │ and `codex exec --json` in Prompt 2).                                        │
 * │                                                                             │
 * │ Prompt 2 WIDENS this interface to a transport-shaped contract:              │
 * │   • readEvents(): AsyncIterable<CanonicalEvent>  — the event SOURCE the bus  │
 * │     consumes. For a line provider it folds stdout lines through a            │
 * │     `parseLine`-style mapper; for a JSON-RPC-over-stdio provider             │
 * │     (`codex app-server`, and P6's Hermes-over-ACP) it is a request/          │
 * │     notification correlator.                                                 │
 * │   • send(request) — an outbound channel (unused by P1's line adapters;       │
 * │     present so a request/response transport has somewhere to send            │
 * │     initialize/prompt/cancel).                                               │
 * │                                                                             │
 * │ To keep that widening additive (not a rewrite), NOTHING downstream may       │
 * │ assume "line-parsing IS the adapter contract." The event source must always │
 * │ be reached through a single adapter method. In P1 that method is            │
 * │ `parseLine`; in P2 it becomes `readEvents`, with `parseLine` demoted to the  │
 * │ line-delimited implementation detail of `readEvents`. The bus (P3) consumes  │
 * │ the adapter's event-producing method, never a free function — so swapping    │
 * │ `parseLine` for `readEvents` touches only the adapters, not the bus or the   │
 * │ renderer.                                                                    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Context seam (pinned now so the widening stays additive): every event is built
 * via `makeEvent(kind, ctx, payload)`, so the event source needs an
 * `EnvelopeContext` (identity + the monotonic `nextSeq` allocator). In P1 that ctx
 * is threaded per-call as `parseLine(line, ctx)`. The P2 successor takes it the
 * SAME single way — `readEvents(ctx: EnvelopeContext): AsyncIterable<CanonicalEvent>`
 * — so both the line-fold mapper and a JSON-RPC notification correlator obtain
 * `nextSeq`/identity identically (a correlator has no per-line boundary to hang ctx
 * on otherwise). When the bus owns `nextSeq` in P3, it simply supplies that ctx.
 */

import type {
  ChildProcessByStdio,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CanonicalEvent, EnvelopeContext } from "./canonical.ts";

/**
 * Result of probing one provider on this machine (for the connect-your-agent
 * picker). The shape MOVED to `@basics/protocol` (it is on the `GET /v1/agents`
 * wire as `AgentInfo`); re-exported here so existing `DetectResult` imports across
 * the engine keep resolving and engine + SDK share ONE definition. Relative `.ts`
 * import so Node type-stripping resolves it without a workspace symlink.
 */
import type { DetectResult } from "./detect.ts";
export type { DetectResult };

/** Options for spawning a headless streaming turn. */
export interface SpawnOptions {
  /** Which agent/provider context (an agent dir ref). Carried into the envelope. */
  agentRef: string;
  /** Working directory the agent operates against. */
  cwd: string;
  /** The user's prompt for this turn. */
  prompt: string;
  /** Optional model override. */
  model?: string;
  /** Optional path to a system-prompt file (engine-assembled; product prompt is the caller's). */
  systemPromptFile?: string;
  /** Provider session id to resume (maps to the CLI's `--resume`-style flag). */
  resumeSessionId?: string;
  /**
   * Whether tools are enabled for this turn. Phase 1 runs autonomously either way
   * (no sign-off gate — that is P5); this only toggles coarse pre-spawn tool
   * gating in the argv. Defaults to enabled.
   */
  enableTools?: boolean;
  /**
   * Extra PATH dirs PREPENDED to the child's login-shell PATH (P2.2). The host sets
   * this to `<stateDir>/bin` so the generated `basics-store` wrapper shadows any real
   * binary and is reachable by the spawned agent.
   */
  extraPathDirs?: string[];
  /**
   * Extra env vars merged into the child env (P2.2). The host sets `BASICS_STORE_DB`
   * (the workspace store.db the `basics-store` CLI opens) here. For Codex (no
   * system-prompt flag) the assembled BASICS_DATA_GUIDANCE is prepended to the prompt
   * instead; for Claude it travels via {@link systemPromptFile}.
   */
  envOverrides?: Record<string, string>;
}

/** A spawned CLI subprocess with piped stdio (stdout carries the NDJSON stream). */
export type SpawnedProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * An outbound request to the agent (used by a request/response transport). In P1
 * the line/JSONL adapters have no inbound channel — the prompt is baked into the
 * spawn argv — so `send` is a no-op. This shape exists so a JSON-RPC-over-stdio
 * transport (`codex app-server`, P6's Hermes-over-ACP) has somewhere to send
 * initialize/prompt/cancel without the interface changing again.
 */
export interface ProviderRequest {
  /** The request kind (e.g. "prompt" | "cancel" | "initialize"). */
  method: string;
  /** Method-specific params, serializable. */
  params?: Record<string, unknown>;
}

/**
 * The NATIVE permission round-trip (P5 — THE GOVERNED AGENT). Modeled on the Claude Agent
 * SDK's `canUseTool` callback ({toolName, input} → {behavior:"allow"|"deny", updatedInput?})
 * and ACP's `request_permission`: it fires SYNCHRONOUSLY (returns a Promise the agent's own
 * permission round-trip awaits) when the agent asks to use a tool. The engine wires its body
 * to MediationLayer.decide(): Allow → answer "allow" (the tool ACTUALLY runs), Deny → answer
 * "deny" (it never runs), Hold → PARK on the hold/resume bridge and answer only when the
 * out-of-band sign-off decision lands. This is what makes the P5 chokepoint wrap the agent's
 * ACTUAL tool-call surface — the side effect cannot happen until decide() says Allow.
 *
 * ADDITIVE per the FORWARD-NOTE: a future request/response transport (codex app-server /
 * Claude Agent SDK canUseTool) invokes this hook; the one-shot line adapters declare it but
 * do not call it (they have no inbound channel — the load-bearing P5 change for them is
 * removing the bypass flag, so the native CLI prompt path is live).
 */
export interface PermissionRequest {
  /** The tool the agent wants to use (e.g. "Bash", "Write", "Edit"). */
  toolName: string;
  /** The tool input, as the agent proposed it (serializable). */
  input: Record<string, unknown>;
}
export interface PermissionDecision {
  /** "allow" releases the agent's call; "deny" refuses it. */
  behavior: "allow" | "deny";
  /** Optional human-readable reason (surfaced to the agent on deny). */
  message?: string;
}
export type PermissionHook = (
  req: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

/**
 * A pluggable provider adapter. One hand-written implementation per CLI.
 *
 * Transport-shaped contract (Prompt 2 widened this ADDITIVELY per the FORWARD-NOTE
 * above): the event SOURCE the bus consumes is `readEvents`, an
 * `AsyncIterable<CanonicalEvent>`. `parseLine` is demoted to the line-delimited
 * IMPLEMENTATION DETAIL of `readEvents` for the two P1 line/JSONL providers (their
 * `readEvents` folds stdout lines through `parseLine` via the shared
 * `linesToEvents` helper). A future JSON-RPC-over-stdio provider implements
 * `readEvents` as a correlator and ignores `parseLine`.
 */
export interface ProviderAdapter {
  /** Stable provider id, e.g. "claude". */
  readonly id: string;

  /** Locate the CLI on PATH and report found/auth state for the picker. */
  detect(): Promise<DetectResult>;

  /**
   * Probe whether the CLI is signed in / usable. Cheap and bounded — must not
   * block indefinitely (a hung probe → treat as unauthenticated/unknown).
   */
  probeAuth(): Promise<boolean>;

  /** Resolve the binary from PATH, build the headless streaming argv, and spawn. */
  spawn(opts: SpawnOptions): Promise<SpawnedProcess>;

  /**
   * THE event source the bus (P3) consumes: the spawned child's native output
   * normalized into the canonical union. Takes the spawned process handle plus an
   * `EnvelopeContext` (because `makeEvent` needs ctx — identity + the monotonic
   * `nextSeq` allocator). For a line/JSONL provider this folds stdout lines
   * through `parseLine`; for a JSON-RPC-over-stdio provider it is a
   * request/notification correlator. Like `parseLine`, it MUST NOT throw on
   * malformed input — it degrades to typed canonical events.
   */
  readEvents(
    child: SpawnedProcess,
    ctx: EnvelopeContext,
  ): AsyncIterable<CanonicalEvent>;

  /**
   * Outbound channel to the agent. No-op for the P1 line/JSONL adapters (the
   * prompt is in the spawn argv); present so a request/response transport has a
   * place to send initialize/prompt/cancel. See {@link ProviderRequest}.
   */
  send(request: ProviderRequest): void | Promise<void>;

  /**
   * Map ONE native stdout line to zero or more canonical events.
   *
   * The line-delimited *implementation detail* of `readEvents` for line/JSONL
   * providers. MUST NOT throw on a malformed/unrecognized line — degrade to a
   * typed canonical event (a `system_message`, or a `provider_error`), never drop,
   * never throw. Downstream consumers reach the event source through `readEvents`,
   * NOT this method.
   */
  parseLine(line: string, ctx: EnvelopeContext): CanonicalEvent[];

  /**
   * OPTIONAL native permission round-trip (P5). When the transport supports an inbound
   * permission ask (Claude Agent SDK canUseTool / codex app-server request_permission), the
   * adapter calls this hook to obtain the Allow/Deny decision the agent's own round-trip
   * awaits. The host installs the hook (wired to MediationLayer.decide) via {@link setPermissionHook}.
   * The P1 one-shot line adapters declare it as a no-op (no inbound channel); their P5
   * enforcement is the removed bypass flag plus the funnel's interception of the surfaced
   * tool events. Additive per the FORWARD-NOTE — nothing downstream requires it.
   */
  setPermissionHook?(hook: PermissionHook): void;
}
