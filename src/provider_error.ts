/**
 * provider_error.ts — the typed provider-error taxonomy (v5 §3).
 *
 * Every provider failure (rate limit, auth, missing CLI, spawn crash, timeout,
 * cancellation, anything else) is normalized into ONE of these kinds before it
 * reaches the canonical event stream, so the UI renders a typed, human-readable
 * state instead of raw stderr. Design re-implemented from the studied reference's
 * `provider_error_kind.rs` (INTEGRATION-ANALYSIS.md §2.3) — no reference code is
 * imported or shipped.
 *
 * Implementation note: this is expressed as the const-object + union "string enum"
 * pattern rather than a TypeScript `enum`. Two reasons: (1) it serializes to its
 * plain string value over the wire and in persisted history with no surprises,
 * and (2) Node's native type-stripping (the engine runs `.ts` directly) does not
 * support `enum`, which would require code generation. The public ergonomics are
 * identical: `ProviderErrorKind.RateLimited` is the value, and `ProviderErrorKind`
 * is also the union type.
 */

export const ProviderErrorKind = {
  /** Provider/API rejected the request for rate/usage reasons (HTTP 429, overloaded). Retryable. */
  RateLimited: "RateLimited",
  /** Not signed in / invalid credentials / forbidden (HTTP 401/403). Not retryable without re-auth. */
  Unauthenticated: "Unauthenticated",
  /** The agent CLI could not be found on the resolved login-shell PATH. */
  CliNotFound: "CliNotFound",
  /** The CLI was found but the subprocess failed to start (exec error, bad argv, crash on launch). */
  SpawnFailed: "SpawnFailed",
  /** The turn exceeded a deadline (spawn/probe/turn timeout). */
  Timeout: "Timeout",
  /** The turn was cancelled by the user (the `:cancel` action). */
  Cancelled: "Cancelled",
  /** Anything not classifiable into the above — never thrown away, always surfaced as typed. */
  Unknown: "Unknown",
} as const;

export type ProviderErrorKind =
  (typeof ProviderErrorKind)[keyof typeof ProviderErrorKind];

/** All kinds, in a stable order — useful for tests and exhaustiveness checks. */
export const ALL_PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] =
  Object.values(ProviderErrorKind);

/**
 * Human-readable, end-user-facing copy for each kind. The UI shows THIS, never a
 * stack trace (Phase 1 acceptance: "typed errors, not raw stderr").
 */
export function toHumanMessage(kind: ProviderErrorKind): string {
  switch (kind) {
    case ProviderErrorKind.RateLimited:
      return "Rate limited — please try again shortly.";
    case ProviderErrorKind.Unauthenticated:
      return "Sign in to your agent CLI to continue.";
    case ProviderErrorKind.CliNotFound:
      return "Agent CLI not found on your PATH.";
    case ProviderErrorKind.SpawnFailed:
      return "Could not start the agent process.";
    case ProviderErrorKind.Timeout:
      return "The agent timed out — please try again.";
    case ProviderErrorKind.Cancelled:
      return "The turn was cancelled.";
    case ProviderErrorKind.Unknown:
      return "Something went wrong with the agent.";
    default: {
      // Exhaustiveness guard: if a kind is added without a message, this fails to compile.
      const _never: never = kind;
      return _never;
    }
  }
}

/**
 * The conventional default for whether a kind is worth retrying. Adapters may
 * override per-event (e.g. a 5xx mapped to Unknown is retryable), but this is the
 * baseline the taxonomy implies.
 */
export function defaultRetryable(kind: ProviderErrorKind): boolean {
  switch (kind) {
    case ProviderErrorKind.RateLimited:
    case ProviderErrorKind.Timeout:
      return true;
    case ProviderErrorKind.Unauthenticated:
    case ProviderErrorKind.CliNotFound:
    case ProviderErrorKind.SpawnFailed:
    case ProviderErrorKind.Cancelled:
    case ProviderErrorKind.Unknown:
      return false;
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}
