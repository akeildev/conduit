/**
 * Conduit — Subscription as a Runtime.
 *
 * Turn any agent CLI a user already pays for (their Claude / Codex / other subscription)
 * into the engine that drives an app: spawn it, normalize its native stdout into ONE
 * canonical event type, and stream the result back like an API.
 *
 * Public surface:
 *   • the locked canonical event type + typed provider-error taxonomy
 *   • the `ProviderAdapter` contract every provider implements
 *   • `defineGenericCli(spec)` — config-driven "bring your own CLI" (no code)
 *   • the manifest loader + a hand-written Codex adapter as a worked reference
 */

// Canonical event type + construction.
export * from "./canonical.ts";
// Typed provider-error taxonomy.
export * from "./provider_error.ts";
// Detection result shape (the connect-your-agent picker row).
export type { DetectResult } from "./detect.ts";
// The provider contract + spawn/permission shapes.
export * from "./types.ts";
// Typed spawn error.
export { ProviderSpawnError } from "./errors.ts";
// Shared seams.
export { resolveLoginShellPath, resolveBinaryOnLoginPath, buildChildEnv } from "./path.ts";
export { linesToEvents, type LineMapper } from "./transport.ts";

// The config-driven "bring your own CLI" adapter.
export {
  defineGenericCli,
  buildGenericArgv,
  parseGenericLine,
  classifyGenericError,
  getPath,
  type GenericCliSpec,
  type GenericArgvSpec,
  type GenericMapping,
  type GenericRule,
  type GenericEmit,
  type GenericEmitKind,
  type FieldSource,
  type PromptDelivery,
  type ResumeForm,
  type ValueFlag,
  type GenericErrorRule,
} from "./generic.ts";

// The registry seam.
export {
  ADAPTERS,
  registerProvider,
  unregisterProvider,
  allAdapters,
  getAdapter,
  detectAgents,
} from "./registry.ts";

// The manifest loader (declare a whole document of CLIs).
export {
  registerCliManifest,
  loadCliManifestFile,
  type ConduitManifest,
  type ConduitRegisterResult,
} from "./manifest.ts";

// Worked specs.
export { codexCompatibleSpec, echoJsonlSpec } from "./examples.ts";

// The hand-written Codex adapter (a worked reference alongside the generic factory).
export {
  CODEX_ID,
  codexAdapter,
  parseCodex,
  spawnCodex,
  buildCodexArgv,
  detectCodex,
  probeCodexAuth,
  resolveCodexBinary,
  classifyCodexError,
} from "./codex.ts";

// The hand-written Claude Code adapter (content-block fan-out needs real code, not config).
export {
  CLAUDE_ID,
  claudeAdapter,
  parseClaude,
  spawnClaude,
  buildClaudeArgv,
  detectClaude,
  probeClaudeAuth,
  resolveClaudeBinary,
  classifyClaudeError,
} from "./claude.ts";
