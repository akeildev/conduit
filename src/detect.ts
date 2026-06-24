/**
 * detect.ts — the agent-detection result shape, shared on the wire.
 *
 * `GET /v1/agents` returns an array of these for the connect-your-agent picker.
 * It is the SAME shape the engine's provider registry produces (`detectAgents()`),
 * so it lives in `@basics/protocol` as the single source of truth: the engine's
 * `providers/types.ts` re-exports `DetectResult` from here, and the SDK names it
 * `AgentInfo` (see api.ts) on its API surface. One definition, both sides.
 */

/** Result of probing one provider on this machine (for the connect-your-agent picker). */
export interface DetectResult {
  /** Stable provider id, e.g. "claude" / "codex". */
  id: string;
  /** Was the CLI found on the resolved login-shell PATH? */
  found: boolean;
  /** Is the CLI signed in / usable? `false` if found-but-logged-out; `false` if not found. */
  authenticated: boolean;
  /** Absolute path to the resolved binary, if found. */
  path?: string;
  /** Reported CLI version, if obtainable. */
  version?: string;
  /** Optional typed detail for the UI (e.g. "sign in required"). Never a stack trace. */
  detail?: string;
}
