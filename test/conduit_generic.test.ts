/**
 * conduit_generic.test.ts — proof for the config-driven "bring your own CLI" adapter.
 *
 * Central claim: a DECLARATIVE GenericCliSpec normalizes a real provider's native stream
 * to the SAME canonical event backbone the HAND-WRITTEN adapter produces — "config, not
 * code" is real. Proven by running `codexCompatibleSpec` (a spec) and the shipped
 * `codexAdapter` (hand-written) over the SAME real Codex fixtures and asserting kind-for-kind
 * equivalence. Plus argv correctness, never-throws-on-garbage, error classification, and the
 * registry/manifest seam.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  makeCounterContext,
  type CanonicalEvent,
  type CanonicalKind,
  type EnvelopeContext,
} from "../src/canonical.ts";
import { codexAdapter, parseCodex } from "../src/codex.ts";
import {
  defineGenericCli,
  buildGenericArgv,
  parseGenericLine,
  classifyGenericError,
} from "../src/generic.ts";
import {
  registerProvider,
  unregisterProvider,
  getAdapter,
  allAdapters,
  ADAPTERS,
} from "../src/registry.ts";
import { registerCliManifest } from "../src/manifest.ts";
import { codexCompatibleSpec } from "../src/examples.ts";
import type { ProviderAdapter, SpawnOptions, SpawnedProcess } from "../src/types.ts";

const CODEX_FIXTURES = join(import.meta.dirname, "fixtures", "codex");

const SIGNIFICANT: ReadonlySet<CanonicalKind> = new Set<CanonicalKind>([
  "assistant_text",
  "thinking",
  "tool_call",
  "tool_result",
  "final_result",
  "provider_error",
  "context_compacted",
]);

function ctx(agentRef: string): EnvelopeContext {
  return makeCounterContext(
    { sessionKey: "g", conversationId: "g", agentRef, topic: "session:g" },
    { startSeq: 0, now: () => "1970-01-01T00:00:00.000Z" },
  );
}

function parseFixture(
  parse: (line: string, c: EnvelopeContext) => CanonicalEvent[],
  file: string,
  agentRef: string,
): CanonicalEvent[] {
  const text = readFileSync(join(CODEX_FIXTURES, file), "utf8");
  const c = ctx(agentRef);
  const out: CanonicalEvent[] = [];
  for (const line of text.split("\n")) out.push(...parse(line, c));
  return out;
}

const backbone = (evts: CanonicalEvent[]): CanonicalKind[] =>
  evts.map((e) => e.kind).filter((k) => SIGNIFICANT.has(k));

// ── THE PROOF ────────────────────────────────────────────────────────────────

test("declarative spec yields the SAME canonical backbone as the hand-written codex adapter, on every real Codex fixture", () => {
  const fixtures = readdirSync(CODEX_FIXTURES).filter((f) => f.endsWith(".jsonl"));
  assert.ok(fixtures.length >= 3, "expected the real Codex fixtures to be present");
  for (const file of fixtures) {
    const handwritten = backbone(parseFixture(parseCodex, file, "codex"));
    const declarative = backbone(
      parseFixture((l, c) => parseGenericLine(codexCompatibleSpec, l, c), file, "codex-generic"),
    );
    assert.deepEqual(
      declarative,
      handwritten,
      `backbone mismatch for ${file}: spec=${JSON.stringify(declarative)} vs code=${JSON.stringify(handwritten)}`,
    );
  }
});

test("declarative spec classifies the rate-limit + auth error fixtures to the right typed errorKind", () => {
  const rl = parseFixture((l, c) => parseGenericLine(codexCompatibleSpec, l, c), "error_rate_limit.jsonl", "g")
    .filter((e) => e.kind === "provider_error");
  assert.ok(rl.length >= 1);
  for (const e of rl) assert.equal((e as { errorKind: string }).errorKind, "RateLimited");

  const auth = parseFixture((l, c) => parseGenericLine(codexCompatibleSpec, l, c), "error_auth.jsonl", "g")
    .filter((e) => e.kind === "provider_error");
  assert.ok(auth.length >= 1);
  for (const e of auth) assert.equal((e as { errorKind: string }).errorKind, "Unauthenticated");
});

// ── argv correctness ──────────────────────────────────────────────────────────

function spawnOpts(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return { agentRef: "a", cwd: "/work", prompt: "hello", model: "gpt-5.5", ...over };
}

test("buildGenericArgv mirrors the codex exec recipe", () => {
  assert.deepEqual(buildGenericArgv(codexCompatibleSpec, spawnOpts()), [
    "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-m", "gpt-5.5", "-C", "/work", "hello",
  ]);
});

test("buildGenericArgv places the resume subcommand right after the leading subcommand", () => {
  const argv = buildGenericArgv(codexCompatibleSpec, spawnOpts({ resumeSessionId: "thread-42" }));
  assert.deepEqual(argv.slice(0, 4), ["exec", "resume", "thread-42", "--json"]);
});

test("buildGenericArgv omits the tools arm when tools are disabled", () => {
  assert.ok(!buildGenericArgv(codexCompatibleSpec, spawnOpts({ enableTools: false })).includes("-s"));
});

test("a required-model spec throws a typed SpawnFailed when no model is given", () => {
  assert.throws(() => buildGenericArgv(codexCompatibleSpec, spawnOpts({ model: undefined })), /requires an explicit model/);
});

test("a flag-form resume + flag-form prompt recipe builds as expected", () => {
  const argv = buildGenericArgv(
    {
      id: "x", binary: "claude", mapping: { rules: [] },
      argv: {
        flags: ["-p", "--output-format", "stream-json"],
        resume: { flag: "--resume" },
        model: { flag: "--model" },
        systemPromptFile: { flag: "--system-prompt-file" },
        prompt: { mode: "flag", flag: "--prompt" },
      },
    },
    spawnOpts({ resumeSessionId: "s1", systemPromptFile: "/tmp/sp.txt" }),
  );
  assert.deepEqual(argv, [
    "-p", "--output-format", "stream-json", "--resume", "s1",
    "--model", "gpt-5.5", "--system-prompt-file", "/tmp/sp.txt", "--prompt", "hello",
  ]);
});

// ── robustness ──────────────────────────────────────────────────────────────

test("parseGenericLine never throws and degrades garbage to a typed system_message", () => {
  const c = ctx("g");
  for (const line of ["", "   ", "not json", "[1,2,3]", '{"no":"discriminator"}', '{"type":"totally-unknown"}']) {
    for (const e of parseGenericLine(codexCompatibleSpec, line, c)) {
      assert.equal(e.kind, "system_message");
    }
  }
  assert.equal(parseGenericLine(codexCompatibleSpec, "", c).length, 0);
  assert.equal(parseGenericLine(codexCompatibleSpec, '{"type":"totally-unknown"}', c).length, 1);
});

test("classifyGenericError unwraps double-JSON-encoded errors and honors spec regex rules", () => {
  const nested = JSON.stringify({ type: "error", status: 429, error: { type: "rate_limit_error", message: "rl" } });
  assert.equal(classifyGenericError(nested).errorKind, "RateLimited");
  assert.equal(classifyGenericError({ status: 401 }).errorKind, "Unauthenticated");
  assert.equal(classifyGenericError("a plain unclassifiable string").errorKind, "Unknown");
  assert.equal(classifyGenericError("quota exceeded", [{ match: "quota", kind: "RateLimited" }]).errorKind, "RateLimited");
});

// ── readEvents over a fake child ──────────────────────────────────────────────

function fakeChild(lines: string[]): SpawnedProcess {
  return { stdout: Readable.from(lines.map((l) => `${l}\n`)) } as unknown as SpawnedProcess;
}

test("a generic adapter's readEvents() folds a child's stdout into canonical events", async () => {
  const adapter = defineGenericCli(codexCompatibleSpec);
  const child = fakeChild([
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hi"}}',
    '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}',
  ]);
  const out: CanonicalEvent[] = [];
  for await (const e of adapter.readEvents(child, ctx("g"))) out.push(e);
  assert.deepEqual(backbone(out), ["assistant_text", "final_result"]);
  const final = out.find((e) => e.kind === "final_result") as { usage: { inputTokens: number } };
  assert.equal(final.usage.inputTokens, 3);
});

// ── registry + manifest seam (the built-in here is Codex) ──────────────────────

test("registerProvider exposes a generic adapter via getAdapter without shadowing the built-in", () => {
  const adapter: ProviderAdapter = defineGenericCli({ ...codexCompatibleSpec, id: "byo-test" });
  try {
    assert.equal(getAdapter("byo-test"), undefined);
    assert.equal(registerProvider(adapter), true);
    assert.equal(getAdapter("byo-test"), adapter);
    assert.ok(allAdapters().some((a) => a.id === "byo-test"));
    assert.equal(registerProvider({ ...adapter, id: "codex" } as ProviderAdapter), false);
    assert.equal(getAdapter("codex"), ADAPTERS.find((a) => a.id === "codex"));
  } finally {
    unregisterProvider("byo-test");
  }
  assert.equal(getAdapter("byo-test"), undefined);
});

test("registerCliManifest brings a whole JSON document of CLIs online", () => {
  const result = registerCliManifest({
    version: 1,
    clis: [
      { ...codexCompatibleSpec, id: "manifest-a" },
      { ...codexCompatibleSpec, id: "manifest-b" },
      { ...codexCompatibleSpec, id: "codex" }, // collides with the built-in → skipped
    ],
  });
  try {
    assert.deepEqual(result.registered.sort(), ["manifest-a", "manifest-b"]);
    assert.deepEqual(result.skipped, ["codex"]);
    assert.ok(getAdapter("manifest-a"));
    assert.ok(getAdapter("manifest-b"));
  } finally {
    unregisterProvider("manifest-a");
    unregisterProvider("manifest-b");
  }
});

test("registerCliManifest fails loudly on a malformed entry", () => {
  assert.throws(() => registerCliManifest({ version: 1, clis: [{ id: "bad" } as never] }), /missing "binary"/);
});

test("the hand-written codex adapter is the registered built-in", () => {
  assert.equal(getAdapter("codex"), codexAdapter);
});
