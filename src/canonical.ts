/**
 * canonical.ts — THE single canonical event type (v5 §3, §19 B1: "lock the
 * single canonical event type").
 *
 * Every provider adapter (Claude Code now; Codex / Hermes-over-ACP later)
 * normalizes its wildly different native stdout into exactly this union. The SDK
 * streaming reducer (Prompt 4), the WS transport + backpressure policy (Prompt 3),
 * and persisted session history (Prompt 5) ALL depend on this shape — so it is
 * locked here and evolved only additively, gated by `schemaVersion`.
 *
 * Design re-implemented from the studied reference's `FeedItem` enum
 * (INTEGRATION-ANALYSIS.md §2.3). No reference code is imported or shipped.
 *
 * Two invariants this file enforces by construction:
 *   1. Every event carries a versioned envelope with a monotonic `seq` and
 *      `schemaVersion` — there is no way to build an event without them (see
 *      `makeEvent` / `baseEnvelope`).
 *   2. Every event is self-describing about transport drop-behaviour via
 *      `kindClass` + `droppable`, derived from a single source of truth
 *      (`KIND_CLASS`). The WS layer (Prompt 3) reads `event.kindClass` directly;
 *      it never needs to re-derive policy from `kind`.
 *
 * Serializability: every field is a JSON primitive, a flat object of primitives
 * (`usage`), or a JSON *string* (`argsJson` / `resultJson`). Arbitrary nested
 * provider shapes are deliberately stringified at the adapter boundary so the
 * canonical type stays flat, diffable, and round-trips through persistence and
 * the wire unchanged.
 */

import type { ProviderErrorKind } from "./provider_error.ts";

/** Current envelope schema version. Start at 1; bump only for additive evolution. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Transport behaviour class for an event kind. The WS backpressure policy
 * (Prompt 3) branches on this:
 *   - 'delta'    → DROPPABLE under load (a lag marker triggers a client refetch).
 *   - 'status'   → COALESCE under load (keep only the latest; never the timeline
 *                  of record). `session_status` is the SOLE member.
 *   - 'content'  → durable conversational content; MUST be delivered.
 *   - 'terminal' → end-of-turn result; MUST be delivered.
 *   - 'error'    → typed provider error; MUST be delivered.
 *   - 'control'  → transport-meta control signal; MUST be delivered. `lag_marker`
 *                  is the SOLE member — it is the resync signal, so it can be
 *                  neither dropped NOR coalesced (losing/overwriting it would
 *                  silently desync the client, the exact failure Prompt 3 prevents).
 *
 * Only 'delta' is ever silently dropped. ONLY 'status' coalesces. Everything else
 * is must-deliver. (The reference offered a bare `droppable` boolean OR a 4-value
 * class; we keep both — `kindClass` for the transport's drop/coalesce/deliver
 * decision, `droppable` as the convenience boolean the spec named — and add
 * 'content' for must-deliver conversational content, plus a dedicated 'control'
 * class so the must-deliver `lag_marker` is never lumped into the coalescing
 * 'status' slot.)
 */
export type KindClass =
  | "delta"
  | "status"
  | "content"
  | "terminal"
  | "error"
  | "control";

/**
 * The discriminant for the canonical union. Every required kind from §3/§19 B1 is
 * present. `session_status` is an additive extension: it is the typed home for a
 * provider's ephemeral, coalescible status pings (e.g. Claude Code's
 * `{type:"system",subtype:"status"}`), which gives the 'status' kindClass a real
 * referent and lets downstream filter ephemeral noise from structural timeline
 * events. It is intentionally NOT in the reference's minimal list; it is here so
 * no real native status event has to be force-fit into `system_message` (which
 * would pollute the durable timeline) or dropped (which the parser must never do).
 */
export type CanonicalKind =
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
  | "provider_error"
  | "lag_marker"
  | "data_change"
  | "build_result"
  // ── P5 (The Governed Agent) mediation-chokepoint events ──
  // Every state-changing action the agent attempts passes through MediationLayer.decide()
  // and surfaces ONE of these on Channel A. They are must-deliver ('content'/'control',
  // NEVER 'delta'): losing a Held or Denied silently would defeat the sign-off gate.
  | "action_intercepted"
  | "action_allowed"
  | "action_held"
  | "action_denied"
  // The draft-then-approve queue artifact (P5.2d): an AI-drafted change parked for
  // human approval. Must-deliver 'content'.
  | "proposed_change_drafted"
  // ── P5.3 THE FOUR-MESSAGE INTERACTION LOOP ──
  // The console renders these over the native permission surface. APPROVE reuses
  // `action_held` (it already carries the verbatim payload + holdId + category).
  // CONNECT / ASK / INTERRUPT are their own kinds; CONNECT + ASK carry a `holdId` so
  // they resolve through the SAME pendingHolds bridge as approve/reject (one registry).
  // All four are must-deliver ('control'): losing one would strand a parked turn.
  | "connect_prompt"
  | "ask_prompt"
  | "turn_interrupted"
  // ── P5.4 COMPOSIO sign-in-once ──
  // A connection became available (sign-in completed) for a (workspace,user). The
  // console flips the connect card; the engine resolves the parked connect hold.
  | "composio_connection_added";

/** Single source of truth mapping each kind to its transport class. */
export const KIND_CLASS: Record<CanonicalKind, KindClass> = {
  assistant_text_streaming: "delta",
  thinking_streaming: "delta",
  assistant_text: "content",
  thinking: "content",
  tool_call: "content",
  tool_result: "content",
  system_message: "content",
  context_compacted: "content",
  session_status: "status",
  final_result: "terminal",
  provider_error: "error",
  // The resync signal — must-deliver, never dropped, never coalesced. See KindClass.
  lag_marker: "control",
  // Channel B reactivity delta (P2.3). DROPPABLE: the client treats a data_change as an
  // invalidation→refetch signal, so dropping one under backpressure is safe (the next
  // delivered change, or a lag marker, makes the client refetch and see all rows). This
  // also routes it through BoundedChannel's existing delta drop path VERBATIM (P2.4).
  data_change: "delta",
  // The P3.3 build-loop TERMINAL artifact — the validated manifest + the INDEPENDENT
  // intent statement + the self-check report. MUST-DELIVER ('content', never dropped
  // nor coalesced): it IS the build's deliverable (like assistant_text), so losing it
  // under backpressure would silently lose the whole build. (Deliberately NOT "delta"
  // like data_change.)
  build_result: "content",
  // ── P5 mediation events ──
  // 'control' for the interception lifecycle so the gate's audit trail is never dropped
  // nor coalesced (an Intercepted/Allowed/Held/Denied that vanished under backpressure
  // would make the chokepoint look like it had a hole). 'content' for the proposed-change
  // draft (it IS the deliverable the human later approves).
  action_intercepted: "control",
  action_allowed: "control",
  action_held: "control",
  action_denied: "control",
  proposed_change_drafted: "content",
  // ── P5.3 four-message loop ── must-deliver 'control' (a stranded connect/ask/interrupt
  // would silently desync the human from a parked turn — the exact failure the gate avoids).
  connect_prompt: "control",
  ask_prompt: "control",
  turn_interrupted: "control",
  // ── P5.4 composio ── must-deliver 'control' (the resolve signal for a parked connect hold).
  composio_connection_added: "control",
};

/** True iff the transport may silently drop this kind under backpressure. */
export function isDroppable(kind: CanonicalKind): boolean {
  return KIND_CLASS[kind] === "delta";
}
/** True iff the transport coalesces this kind under backpressure (keep latest). */
export function coalesces(kind: CanonicalKind): boolean {
  return KIND_CLASS[kind] === "status";
}
/** True iff the transport must deliver this kind (never drop/lose it). */
export function mustDeliver(kind: CanonicalKind): boolean {
  const c = KIND_CLASS[kind];
  return c !== "delta" && c !== "status";
}

/**
 * The versioned envelope present on EVERY canonical event.
 *
 * `seq` is monotonic *per session* and is the single ordering authority. In
 * Phase 1 it is assigned by the parse context's `nextSeq()` allocator; from
 * Prompt 3 onward the event bus owns that allocator (one per session) so the bus
 * remains the source of truth for ordering. `kindClass`/`droppable` are derived
 * from `kind` via `KIND_CLASS` at construction, never hand-set.
 */
export interface EventEnvelope {
  /** Envelope schema version (currently `SCHEMA_VERSION`). */
  schemaVersion: number;
  /** Monotonic per-session sequence number; the ordering + reconciliation key. */
  seq: number;
  /** Frontend-owned conversation turn key (the session). */
  sessionKey: string;
  /** Frontend-owned conversation id (groups sessions in a conversation). */
  conversationId: string;
  /** Which agent/provider context produced this (e.g. an agent dir ref). */
  agentRef: string;
  /** Pub/sub topic this event publishes on (e.g. `session:{sessionKey}`). */
  topic: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Transport behaviour class — see {@link KindClass}. */
  kindClass: KindClass;
  /** Convenience boolean: `kindClass === 'delta'`. */
  droppable: boolean;
}

/** Token-usage accounting carried by a final result. Extensible (the spec's "…"). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Provider-specific extras are allowed but always numeric. */
  [key: string]: number | undefined;
}

// ── The variants ────────────────────────────────────────────────────────────

/** Final, consolidated assistant text for a content block. */
export interface AssistantTextEvent extends EventEnvelope {
  kind: "assistant_text";
  text: string;
}
/** A streamed assistant-text delta (droppable; coalesced into the final by the reducer). */
export interface AssistantTextStreamingEvent extends EventEnvelope {
  kind: "assistant_text_streaming";
  deltaText: string;
}
/** Final, consolidated thinking/reasoning text for a content block. */
export interface ThinkingEvent extends EventEnvelope {
  kind: "thinking";
  text: string;
}
/** A streamed thinking delta (droppable). */
export interface ThinkingStreamingEvent extends EventEnvelope {
  kind: "thinking_streaming";
  deltaText: string;
}
/**
 * A tool invocation. Emitted ONCE, from the consolidated assistant message where
 * the arguments are complete (not from the streaming `input_json_delta`s).
 * `argsJson` is the tool input serialized as a JSON string.
 */
export interface ToolCallEvent extends EventEnvelope {
  kind: "tool_call";
  toolName: string;
  callId: string;
  argsJson: string;
}
/**
 * A tool result, paired to its call by `callId`. `resultJson` is the result
 * serialized as a JSON string. MUST be delivered (never dropped).
 */
export interface ToolResultEvent extends EventEnvelope {
  kind: "tool_result";
  callId: string;
  resultJson: string;
  isError: boolean;
}
/** A provider/system informational message surfaced into the durable timeline. */
export interface SystemMessageEvent extends EventEnvelope {
  kind: "system_message";
  text: string;
}
/** Ephemeral, coalescible status ping (e.g. "requesting", "streaming"). */
export interface SessionStatusEvent extends EventEnvelope {
  kind: "session_status";
  status: string;
  detail?: string;
}
/** The provider compacted/condensed its context window. MUST be delivered. */
export interface ContextCompactedEvent extends EventEnvelope {
  kind: "context_compacted";
  reason?: string;
}
/** Terminal turn result with cost + usage. MUST be delivered. */
export interface FinalResultEvent extends EventEnvelope {
  kind: "final_result";
  costUsd: number;
  usage: Usage;
  stopReason: string | null;
}
/**
 * A typed provider error. MUST be delivered.
 *
 * NB: the spec describes this as `{kind, message, retryable}`. The field is named
 * `errorKind` here (not `kind`) because `kind` is the union discriminant for the
 * whole canonical type — `errorKind` IS the spec's `{kind}` (a {@link ProviderErrorKind}).
 */
export interface ProviderErrorEvent extends EventEnvelope {
  kind: "provider_error";
  errorKind: ProviderErrorKind;
  message: string;
  retryable: boolean;
}
/**
 * Emitted by the TRANSPORT (Prompt 3), not by an adapter — defined here so the
 * SDK can type it. Tells a lagging subscriber that `droppedCount` droppable
 * events were dropped since `sinceSeq`, so it must refetch authoritative history.
 *
 * Classed `'control'` (must-deliver): this is the resync signal, so the transport
 * must NEVER drop or coalesce it. If a queued lag_marker were overwritten (e.g. by
 * a later coalescing status), the client would never learn it lost events and
 * would silently desync — precisely what the lag-marker mechanism exists to prevent.
 */
export interface LagMarkerEvent extends EventEnvelope {
  kind: "lag_marker";
  droppedCount: number;
  sinceSeq: number;
}
/**
 * A relational-store change notification — Channel B reactivity (P2.3). Emitted by the
 * engine's change-feed DRAINER (not an adapter): it polls the `_changes` reactivity
 * outbox (filled by DB triggers, writer-agnostic — even an agent's direct `basics-store`
 * write across processes is captured) and publishes one of these per changed table per
 * drain window on the shared bus, on the data topic `data:{workspaceId}[:{table}]`.
 *
 * Classed `'delta'` (DROPPABLE): the client treats it as an INVALIDATION→REFETCH signal,
 * so a dropped change is safe — a later change (or a lag marker) triggers a refetch that
 * sees every row. `data` carries the `_changes.payload` (FULL NEW ROW IMAGE on
 * insert/update, PRIOR KEY on delete) for a faithfully-emitted single change; for a
 * COALESCED burst (many changes to one table in one window) it carries the last change's
 * payload (the client refetches the table, so no fact is lost), or `null` if unavailable.
 */
export interface DataChangeEvent extends EventEnvelope {
  kind: "data_change";
  table: string;
  op: "insert" | "update" | "delete";
  rowPk: string;
  workspaceId: string;
  owningAppId: string;
  at: string;
  data?: Record<string, unknown> | null;
}

/**
 * The TERMINAL artifact of a P3.3 build loop — emitted ONCE as the final Channel-A
 * event of a `POST /v1/build` turn (over the SAME `session:{sessionKey}` topic, never
 * a side channel) so the SDK can render the validated app definition + its independent
 * intent statement + the self-check report.
 *
 * Classed 'content' (must-deliver): it is the build's deliverable, so the transport
 * must never drop or coalesce it. Every field is a JSON primitive, a flat object of
 * primitives, an array of them, or a plain serializable object (`manifest` carried as
 * a plain object exactly like `data_change.data`) — satisfying the canonical
 * serializability invariant.
 *
 * `intentStatement` is the INDEPENDENT plain-language re-description of the user's
 * request (NOT a serialization of the manifest); it is snapshotted at emit so a later
 * manifest mutation cannot retroactively change it.
 */
export interface BuildResultEvent extends EventEnvelope {
  kind: "build_result";
  /** meta.appId of the built app definition. */
  appId: string;
  /** Owning workspace (partition key the app definition is persisted under). */
  workspaceId: string;
  /** The full validated 7-section manifest, as a plain serializable object. */
  manifest: Record<string, unknown>;
  /** The INDEPENDENT intent statement (authored from the request, not the manifest). */
  intentStatement: string;
  /** Conservatively-completed / surfaced assumptions, each correctable in one line. */
  assumptions: { section: string; text: string; correctable?: string }[];
  /** Genuine high-stakes forks left open (usually empty). */
  openQuestions: string[];
  /** The structural validator's report (ok ⟺ no errors). */
  validatorReport: {
    ok: boolean;
    errors: { code: string; path: string; message: string }[];
    warnings: { code: string; path: string; message: string }[];
  };
  /** True once the app definition row has been written to the P2 store. */
  persisted: boolean;
}

// ── P5 (The Governed Agent) mediation events ──────────────────────────────────
//
// These narrate the interception CHOKEPOINT (MediationLayer.decide). Every
// state-changing action the agent attempts emits an `action_intercepted`, then
// exactly one terminal verdict: `action_allowed` (executed), `action_held`
// (parked for out-of-band sign-off), or `action_denied` (refused; never ran).
// `targetJson` / `payloadJson` are the VERBATIM target + payload (no summary, no
// redaction — surfacing the exact write the human signs off on is the whole point).

/** The agent attempted a state-changing action; it entered the chokepoint. */
export interface ActionInterceptedEvent extends EventEnvelope {
  kind: "action_intercepted";
  /** The action kind: write | exec | read. */
  actionKind: string;
  /** The tool/surface the action came through (e.g. "data.mutate", "basics-store", "Bash"). */
  tool: string;
  /** The target (table / file path / endpoint), verbatim. */
  target: string;
  /** The full payload (values/where, or the raw SQL/command), verbatim — never summarized. */
  payloadJson: string;
  /** The writing app's owning_app_id (single-writer + cross-app checks key on this). */
  appId: string;
}
/** The chokepoint ALLOWED the action; the side effect executes. */
export interface ActionAllowedEvent extends EventEnvelope {
  kind: "action_allowed";
  actionKind: string;
  tool: string;
  target: string;
}
/**
 * The chokepoint HELD the action for explicit human sign-off. Carries the
 * `holdId` the out-of-band REST decision resolves, plus the VERBATIM target +
 * payload the human reviews. The native tool call is parked until approve/reject.
 */
export interface ActionHeldEvent extends EventEnvelope {
  kind: "action_held";
  holdId: string;
  actionKind: string;
  tool: string;
  target: string;
  /** The full payload, VERBATIM — the approval surface shows exactly this, never a summary. */
  payloadJson: string;
  /** The consequence category that triggered the hold (money/access/deletion/…). */
  category: string;
}
/** The chokepoint DENIED the action; it never ran. */
export interface ActionDeniedEvent extends EventEnvelope {
  kind: "action_denied";
  actionKind: string;
  tool: string;
  target: string;
  /** Why it was denied (e.g. "cross-app", the offending category). */
  reason: string;
}
/**
 * An AI-DRAFTED change parked in the workspace draft-then-approve queue (P5.2d).
 * Distinct from a held tool call: a held call releases a LIVE agent invocation;
 * this stores a DIFF that a later approve applies. Nothing auto-applies.
 */
export interface ProposedChangeDraftedEvent extends EventEnvelope {
  kind: "proposed_change_drafted";
  changeId: string;
  workspaceId: string;
  /** The app that drafted the change. */
  originAppId: string;
  /** The artifact kind: skill | memory | manifest | schema. */
  artifactKind: string;
  /** The proposed diff, VERBATIM (the human approves exactly this). */
  diffJson: string;
  /** A one-line rationale for the change. */
  rationale: string;
}

// ── P5.3 THE FOUR-MESSAGE INTERACTION LOOP ────────────────────────────────────
//
// The console renders four distinct interaction messages over the native permission
// surface. APPROVE reuses ActionHeldEvent (above) — it already carries the holdId +
// VERBATIM payload + category, and the APPROVE modal renders an action_held with REJECT
// default-focused. The other three are below. CONNECT + ASK carry a `holdId` so the
// console resolves them through the SAME hold/resume bridge (one pendingHolds registry).

/**
 * CONNECT — a MISSING connection (a capability the agent reached for that has no granted
 * connector) produced a sign-in/connect prompt. This falls out of least-privilege
 * STRUCTURALLY (CapabilityModel.has() === false inside decide()), never from agent
 * prompting. The console renders a "Connect {toolkit}" card; signing in once resolves
 * the parked hold (`holdId`) and the capability becomes available.
 */
export interface ConnectPromptEvent extends EventEnvelope {
  kind: "connect_prompt";
  holdId: string;
  /** The connector/toolkit the agent needs (e.g. "gmail", "slack"). */
  toolkit: string;
  /** The capability the agent was reaching for (e.g. "gmail.send"). */
  capability: string;
  /** Which (workspace,user) the connection is scoped to. */
  workspaceId: string;
  userId: string;
}
/**
 * ASK — the agent asks the human a question mid-turn (a runtime elicitation). The turn
 * WAITS (parked on `holdId`); answering resolves the hold and the turn resumes from the
 * pause (it does not restart). Rendered as an inline question + answer box.
 */
export interface AskPromptEvent extends EventEnvelope {
  kind: "ask_prompt";
  holdId: string;
  /** The question, verbatim. */
  question: string;
}
/**
 * INTERRUPT — the human interrupted a running turn. Emitted when a cancel/redirect lands;
 * the console shows the turn was interrupted. Reuses the P1 cancel path under the hood.
 */
export interface TurnInterruptedEvent extends EventEnvelope {
  kind: "turn_interrupted";
  /** Optional redirect instruction the human injected (empty for a plain stop). */
  redirect?: string;
}
/**
 * COMPOSIO connection added — a sign-in-once flow completed and a connector is now
 * available for a (workspace,user). The console flips the connect card to "connected";
 * the engine resolves the parked connect hold so the agent's action can proceed.
 */
export interface ComposioConnectionAddedEvent extends EventEnvelope {
  kind: "composio_connection_added";
  /** The connector/toolkit now connected. */
  toolkit: string;
  workspaceId: string;
  userId: string;
  /** The hold this connection resolves (empty if not tied to a parked hold). */
  holdId?: string;
}

/** THE canonical event union. Fully discriminated by `kind`. */
export type CanonicalEvent =
  | AssistantTextEvent
  | AssistantTextStreamingEvent
  | ThinkingEvent
  | ThinkingStreamingEvent
  | ToolCallEvent
  | ToolResultEvent
  | SystemMessageEvent
  | SessionStatusEvent
  | ContextCompactedEvent
  | FinalResultEvent
  | ProviderErrorEvent
  | LagMarkerEvent
  | DataChangeEvent
  | BuildResultEvent
  | ActionInterceptedEvent
  | ActionAllowedEvent
  | ActionHeldEvent
  | ActionDeniedEvent
  | ProposedChangeDraftedEvent
  | ConnectPromptEvent
  | AskPromptEvent
  | TurnInterruptedEvent
  | ComposioConnectionAddedEvent;

/** Map from a kind to its concrete event type (for typed construction). */
export type EventOfKind<K extends CanonicalKind> = Extract<
  CanonicalEvent,
  { kind: K }
>;

/** Just the payload fields of a given kind (everything that isn't envelope/kind). */
type PayloadOf<K extends CanonicalKind> = Omit<
  EventOfKind<K>,
  keyof EventEnvelope | "kind"
>;

// ── Construction ──────────────────────────────────────────────────────────────

/**
 * The session-scoped context an adapter needs to stamp a complete envelope. The
 * parser cannot know `seq`/`ts` on its own, so they are injected: this keeps
 * `seq` assignment with whoever owns ordering (the parse context in P1; the event
 * bus from P3) while still guaranteeing every produced event is complete and
 * `seq`/`schemaVersion`-stamped (a Phase-1 acceptance criterion). `now` is
 * injectable so tests are deterministic.
 */
export interface EnvelopeContext {
  sessionKey: string;
  conversationId: string;
  agentRef: string;
  topic: string;
  /** Allocates the next monotonic per-session seq. */
  nextSeq: () => number;
  /** Returns an ISO-8601 timestamp. Defaults to wall-clock if omitted by helper. */
  now?: () => string;
  /** Override the schema version (defaults to {@link SCHEMA_VERSION}). */
  schemaVersion?: number;
}

function baseEnvelope<K extends CanonicalKind>(
  kind: K,
  ctx: EnvelopeContext,
): EventEnvelope & { kind: K } {
  const kindClass = KIND_CLASS[kind];
  return {
    schemaVersion: ctx.schemaVersion ?? SCHEMA_VERSION,
    seq: ctx.nextSeq(),
    sessionKey: ctx.sessionKey,
    conversationId: ctx.conversationId,
    agentRef: ctx.agentRef,
    topic: ctx.topic,
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
    kindClass,
    droppable: kindClass === "delta",
    kind,
  };
}

/**
 * The ONLY supported way to construct a canonical event. Guarantees the envelope
 * (incl. `seq`, `schemaVersion`, and correct `kindClass`/`droppable`) is always
 * present and consistent. Adapters, the bus, and tests build events exclusively
 * through this so the locked invariants cannot be violated by hand.
 */
export function makeEvent<K extends CanonicalKind>(
  kind: K,
  ctx: EnvelopeContext,
  payload: PayloadOf<K>,
): EventOfKind<K> {
  return { ...baseEnvelope(kind, ctx), ...payload } as EventOfKind<K>;
}

/** Narrow a `CanonicalEvent` to a specific kind (handy in reducers/renderers). */
export function isKind<K extends CanonicalKind>(
  event: CanonicalEvent,
  kind: K,
): event is EventOfKind<K> {
  return event.kind === kind;
}

/**
 * A simple monotonic seq allocator + ISO clock bundled into an EnvelopeContext.
 * Used by the replay CLI and tests; the bus supplies its own per-session one.
 */
export function makeCounterContext(
  base: Omit<EnvelopeContext, "nextSeq" | "now">,
  opts: { startSeq?: number; now?: () => string } = {},
): EnvelopeContext {
  let n = opts.startSeq ?? 0;
  return {
    ...base,
    nextSeq: () => n++,
    now: opts.now ?? (() => new Date().toISOString()),
  };
}
