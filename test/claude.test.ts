/**
 * claude.test.ts — proof for the hand-written Claude Code adapter.
 *
 * Claude is hand-written (not a GenericCliSpec) because one `assistant` line fans an
 * ARRAY of content blocks (text + thinking + tool_use) out to multiple canonical events,
 * and tool results arrive on a separate `user` line. These tests pin: argv correctness,
 * the canonical backbone over the REAL captured fixture, content-block fan-out, tool
 * call/result pairing, error classification, and never-throws-on-garbage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeCounterContext,
  type CanonicalEvent,
  type CanonicalKind,
  type EnvelopeContext,
} from "../src/canonical.ts";
import {
  parseClaude,
  buildClaudeArgv,
  classifyClaudeError,
  claudeAdapter,
} from "../src/claude.ts";
import { getAdapter } from "../src/registry.ts";
import type { SpawnOptions } from "../src/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "claude");

const SIGNIFICANT: ReadonlySet<CanonicalKind> = new Set<CanonicalKind>([
  "assistant_text", "thinking", "tool_call", "tool_result", "final_result", "provider_error",
]);

function ctx(agentRef = "claude"): EnvelopeContext {
  return makeCounterContext(
    { sessionKey: "c", conversationId: "c", agentRef, topic: "session:c" },
    { startSeq: 0, now: () => "1970-01-01T00:00:00.000Z" },
  );
}

function parseFixture(file: string): CanonicalEvent[] {
  const text = readFileSync(join(FIXTURES, file), "utf8");
  const c = ctx();
  const out: CanonicalEvent[] = [];
  for (const line of text.split("\n")) out.push(...parseClaude(line, c));
  return out;
}

const backbone = (evts: CanonicalEvent[]): CanonicalKind[] =>
  evts.map((e) => e.kind).filter((k) => SIGNIFICANT.has(k));

function spawnOpts(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return { agentRef: "a", cwd: "/work", prompt: "hello", ...over };
}

// ── argv ──────────────────────────────────────────────────────────────────────

test("buildClaudeArgv mirrors the headless stream-json recipe (tools on by default)", () => {
  assert.deepEqual(buildClaudeArgv(spawnOpts()), [
    "-p", "hello", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
  ]);
});

test("buildClaudeArgv uses an empty allowlist when tools are disabled", () => {
  const argv = buildClaudeArgv(spawnOpts({ enableTools: false }));
  assert.ok(!argv.includes("--permission-mode"));
  const i = argv.indexOf("--allowedTools");
  assert.ok(i >= 0 && argv[i + 1] === "");
});

test("buildClaudeArgv adds --model and --resume only when given", () => {
  const base = buildClaudeArgv(spawnOpts());
  assert.ok(!base.includes("--model") && !base.includes("--resume"));
  const full = buildClaudeArgv(spawnOpts({ model: "claude-opus-4-8", resumeSessionId: "s-1" }));
  assert.equal(full[full.indexOf("--resume") + 1], "s-1");
  assert.equal(full[full.indexOf("--model") + 1], "claude-opus-4-8");
});

// ── the proof: real fixture → canonical backbone ───────────────────────────────

test("the real captured turn yields assistant_text then final_result", () => {
  const evts = parseFixture("plain_text.jsonl");
  assert.deepEqual(backbone(evts), ["assistant_text", "final_result"]);

  const textEv = evts.find((e) => e.kind === "assistant_text") as { text: string };
  assert.equal(textEv.text, "CLAUDE-SHAPE-OK");

  const sys = evts.find((e) => e.kind === "system_message") as { text: string };
  assert.match(sys.text, /^Session started \(session=/);

  const rl = evts.find((e) => e.kind === "session_status") as { status: string };
  assert.equal(rl.status, "rate_limit");

  const final = evts.find((e) => e.kind === "final_result") as { usage: { inputTokens: number }; costUsd: number; stopReason: string };
  assert.equal(final.usage.inputTokens, 6363);
  assert.equal(final.stopReason, "end_turn");
  assert.ok(final.costUsd > 0);
});

// ── content-block fan-out + tool pairing (inline shapes) ───────────────────────

test("an assistant line fans text + thinking + tool_use blocks into separate events", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "doing it" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ] },
  });
  const evts = parseClaude(line, ctx());
  assert.deepEqual(evts.map((e) => e.kind), ["thinking", "assistant_text", "tool_call"]);
  const call = evts[2] as { toolName: string; callId: string; argsJson: string };
  assert.equal(call.toolName, "Bash");
  assert.equal(call.callId, "tu_1");
  assert.deepEqual(JSON.parse(call.argsJson), { command: "ls" });
});

test("a user line maps tool_result blocks, paired by tool_use_id, honoring is_error", () => {
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] },
  });
  const evts = parseClaude(line, ctx());
  assert.equal(evts.length, 1);
  const r = evts[0] as { kind: string; callId: string; isError: boolean; resultJson: string };
  assert.equal(r.kind, "tool_result");
  assert.equal(r.callId, "tu_1");
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.resultJson), "ok");
});

// ── errors ──────────────────────────────────────────────────────────────────

test("a result with is_error true becomes a classified provider_error", () => {
  const line = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Usage limit reached — rate_limit" });
  const evts = parseClaude(line, ctx());
  assert.equal(evts.length, 1);
  const e = evts[0] as { kind: string; errorKind: string };
  assert.equal(e.kind, "provider_error");
  assert.equal(e.errorKind, "RateLimited");
});

test("classifyClaudeError maps auth + rate-limit + unknown text", () => {
  assert.equal(classifyClaudeError("Please log in to continue").errorKind, "Unauthenticated");
  assert.equal(classifyClaudeError("429 too many requests").errorKind, "RateLimited");
  assert.equal(classifyClaudeError("out_of_credits").errorKind, "RateLimited");
  assert.equal(classifyClaudeError("some weird failure").errorKind, "Unknown");
});

// ── robustness ────────────────────────────────────────────────────────────────

test("parseClaude never throws and degrades garbage to a typed system_message", () => {
  const c = ctx();
  for (const line of ["", "   ", "not json", "[1,2,3]", '{"no":"discriminator"}', '{"type":"totally-unknown"}']) {
    for (const e of parseClaude(line, c)) assert.equal(e.kind, "system_message");
  }
  assert.equal(parseClaude("", c).length, 0);
  assert.equal(parseClaude('{"type":"stream_event"}', c).length, 0);
});

// ── registry ──────────────────────────────────────────────────────────────────

test("claude is a registered built-in adapter", () => {
  assert.equal(getAdapter("claude"), claudeAdapter);
});
