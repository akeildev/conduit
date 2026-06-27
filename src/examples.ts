/**
 * conduit/examples.ts — worked {@link GenericCliSpec} examples.
 *
 * `codexCompatibleSpec` re-expresses the Codex `exec --json` stream as a DECLARATIVE
 * spec. It exists to prove the central claim of the generic adapter: a config spec
 * normalizes a real provider's native stream to the SAME canonical backbone the
 * hand-written adapter produces (see test/conduit_generic.test.ts, which runs it over
 * the real Codex fixtures and asserts kind-for-kind equivalence with codex.ts).
 *
 * `echoJsonlSpec` is the minimal "bring your own CLI" teaching example: any CLI that
 * prints `{"type":"text","content":"…"}` / `{"type":"done"}` lines is online with this.
 *
 * These are EXAMPLES, not the shipped Codex provider — the engine uses the hand-written
 * codex.ts (its double-encoded-error nesting + exit-code→isError logic need real code).
 * The spec form is for the broad class of already-JSONL CLIs that don't.
 */

import type { GenericCliSpec } from "./generic.ts";

/**
 * A declarative spec mirroring the Codex `exec --json` stream (v0.141.0 event shapes),
 * for the kind-backbone equivalence proof. Argv mirrors buildCodexArgv: `exec`, resume
 * subcommand form, `--json --skip-git-repo-check`, `-a on-request` when tools enabled,
 * `-m <model>` (required), `-C <cwd>`, trailing positional prompt.
 */
export const codexCompatibleSpec: GenericCliSpec = {
  id: "codex-generic",
  displayName: "Codex (declarative)",
  binary: "codex",
  discriminator: "type",
  argv: {
    leading: ["exec"],
    flags: ["--json", "--skip-git-repo-check"],
    resume: { subcommand: ["resume"] },
    model: { flag: "-m", required: true },
    cwd: { flag: "-C" },
    toolsEnabled: ["--dangerously-bypass-approvals-and-sandbox"],
    prompt: { mode: "positional" },
  },
  errorRules: [
    { match: "rate.?limit|overloaded|\\b429\\b", kind: "RateLimited" },
    { match: "authentication|unauthor|\\b401\\b|\\b403\\b", kind: "Unauthenticated" },
  ],
  mapping: {
    rules: [
      {
        match: [{ field: "type", equals: "thread.started" }],
        emit: [{ kind: "system_message", fields: { text: { template: "Session started (thread={thread_id})" } } }],
      },
      {
        match: [{ field: "type", equals: "turn.started" }],
        emit: [{ kind: "session_status", fields: { status: { const: "turn_started" } } }],
      },
      // item.started — tool calls surface here; final-text items carry no content yet (swallow).
      {
        match: [{ field: "type", equals: "item.started" }, { field: "item.type", equals: "command_execution" }],
        emit: [{ kind: "tool_call", fields: { toolName: { const: "command_execution" }, callId: { path: "item.id" }, argsJson: { jsonPath: "item" } } }],
      },
      {
        match: [{ field: "type", equals: "item.started" }, { field: "item.type", equals: "file_change" }],
        emit: [{ kind: "tool_call", fields: { toolName: { const: "file_change" }, callId: { path: "item.id" }, argsJson: { jsonPath: "item.changes" } } }],
      },
      { match: [{ field: "type", equals: "item.started" }, { field: "item.type", equals: "agent_message" }], emit: [] },
      { match: [{ field: "type", equals: "item.started" }, { field: "item.type", equals: "reasoning" }], emit: [] },
      // item.completed — the terminal content of each item.
      {
        match: [{ field: "type", equals: "item.completed" }, { field: "item.type", equals: "command_execution" }],
        emit: [{ kind: "tool_result", fields: { callId: { path: "item.id" }, resultJson: { jsonPath: "item" } } }],
      },
      {
        match: [{ field: "type", equals: "item.completed" }, { field: "item.type", equals: "file_change" }],
        emit: [{ kind: "tool_result", fields: { callId: { path: "item.id" }, resultJson: { jsonPath: "item" } } }],
      },
      {
        match: [{ field: "type", equals: "item.completed" }, { field: "item.type", equals: "agent_message" }],
        emit: [{ kind: "assistant_text", fields: { text: { path: "item.text" } } }],
      },
      {
        match: [{ field: "type", equals: "item.completed" }, { field: "item.type", equals: "reasoning" }],
        emit: [{ kind: "thinking", fields: { text: { path: "item.text" } } }],
      },
      { match: [{ field: "type", equals: "item.updated" }], emit: [] },
      {
        match: [{ field: "type", equals: "turn.completed" }],
        emit: [{ kind: "final_result", usagePath: "usage", fields: { stopReason: { const: "completed" } } }],
      },
      {
        match: [{ field: "type", equals: "turn.failed" }],
        emit: [{ kind: "provider_error", classifyFrom: "error" }],
      },
      {
        match: [{ field: "type", equals: "error" }],
        emit: [{ kind: "provider_error", classifyFrom: "message" }],
      },
    ],
    fallback: true,
  },
};

/**
 * The smallest useful BYO-CLI: a hypothetical `mycli --stream <prompt>` that prints
 * `{"type":"text","content":"…"}` then `{"type":"done"}`. This is the copy-paste
 * starting point in the Conduit docs.
 */
export const echoJsonlSpec: GenericCliSpec = {
  id: "echo-jsonl",
  displayName: "Echo JSONL (demo)",
  binary: "mycli",
  argv: {
    flags: ["--stream"],
    model: { flag: "--model" },
    prompt: { mode: "positional" },
  },
  mapping: {
    rules: [
      { match: [{ field: "type", equals: "text" }], emit: [{ kind: "assistant_text", fields: { text: { path: "content" } } }] },
      { match: [{ field: "type", equals: "error" }], emit: [{ kind: "provider_error", classifyFrom: "message" }] },
      { match: [{ field: "type", equals: "done" }], emit: [{ kind: "final_result", fields: { stopReason: { const: "completed" } } }] },
    ],
    fallback: true,
  },
};
