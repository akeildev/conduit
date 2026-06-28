#!/usr/bin/env node
/**
 * conduit — the CLI. Run an agent CLI through Conduit and watch the normalized
 * canonical event stream, or see which agent CLIs are installed on this machine.
 *
 * No install, no registry: clone the repo and run it directly (Node >= 23.6 runs
 * the `.ts` sources as-is via native type-stripping).
 *
 *   node bin/conduit.ts detect
 *   node bin/conduit.ts run codex "summarize this repo"
 *   node bin/conduit.ts run codex "hi" --model gpt-5.1-codex --json
 */

import { detectAgents, getAdapter, makeCounterContext } from "../src/index.ts";
import type { CanonicalEvent } from "../src/index.ts";

const HELP = `conduit — bring-your-own-CLI runtime

Usage:
  conduit detect                       list agent CLIs found on this machine
  conduit run <provider> "<prompt>"    run one turn, stream canonical events
  conduit providers                    list the built-in providers

Options (run):
  --model <m>     model to use (some CLIs, e.g. codex, require one)
  --cwd <dir>     working directory for the turn (default: current dir)
  --json          print one raw canonical event per line (NDJSON)

Examples:
  node bin/conduit.ts detect
  node bin/conduit.ts run codex "list the files here" --model gpt-5.1-codex
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdDetect(): Promise<void> {
  const found = await detectAgents();
  for (const a of found) {
    const state = !a.found ? "not found" : a.authenticated ? "ready" : "needs sign-in";
    const ver = a.version ? `  ${a.version}` : "";
    console.log(`${a.found && a.authenticated ? "●" : "○"} ${a.id.padEnd(10)} ${state}${ver}`);
  }
}

function render(e: CanonicalEvent): string | null {
  switch (e.kind) {
    case "assistant_text": return `assistant  ${e.text}`;
    case "thinking": return `thinking   ${e.text}`;
    case "tool_call": return `tool       ${e.toolName} ${e.argsJson}`;
    case "tool_result": return `result     ${e.isError ? "(error) " : ""}${e.resultJson.slice(0, 160)}`;
    case "provider_error": return `error      [${e.errorKind}] ${e.message}`;
    case "final_result": return `done       stop=${e.stopReason} · in=${e.usage.inputTokens} out=${e.usage.outputTokens}`;
    case "system_message": return `· ${e.text}`;
    case "session_status": return null; // ephemeral; hide from the pretty view
    default: return `${e.kind}`;
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const providerId = args[0];
  if (!providerId) { console.error("conduit run: missing <provider> (e.g. codex)\n"); console.error(HELP); return 2; }
  const adapter = getAdapter(providerId);
  if (!adapter) { console.error(`conduit run: unknown provider "${providerId}". Try: conduit providers`); return 2; }

  const asJson = args.includes("--json");
  const model = flag(args, "--model");
  const cwd = flag(args, "--cwd") ?? process.cwd();
  // The prompt is every positional arg that isn't a flag/flag-value.
  const skip = new Set<string>();
  for (const f of ["--model", "--cwd"]) { const i = args.indexOf(f); if (i >= 0) { skip.add(f); skip.add(args[i + 1] ?? ""); } }
  const prompt = args.slice(1).filter((a) => a !== "--json" && !skip.has(a)).join(" ").trim();
  if (!prompt) { console.error('conduit run: missing prompt, e.g. conduit run codex "hello"'); return 2; }

  const ctx = makeCounterContext({
    sessionKey: "cli", conversationId: "cli", agentRef: providerId, topic: "session:cli",
  });

  try {
    const child = await adapter.spawn({ agentRef: providerId, cwd, prompt, ...(model ? { model } : {}) });
    let failed = false;
    for await (const event of adapter.readEvents(child, ctx)) {
      if (asJson) { console.log(JSON.stringify(event)); continue; }
      if (event.kind === "provider_error") failed = true;
      const line = render(event);
      if (line) console.log(line);
    }
    return failed ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`conduit run: ${msg}`);
    if (/model/i.test(msg)) console.error(`hint: pass one with --model, e.g. --model gpt-5.1-codex`);
    return 1;
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "detect": await cmdDetect(); return 0;
    case "providers":
      console.log("Built-in: claude, codex (both hand-written). Add any JSONL CLI via a conduit manifest — see docs/CONDUIT.md.");
      return 0;
    case "run": return cmdRun(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help": console.log(HELP); return 0;
    default: console.error(`conduit: unknown command "${cmd}"\n`); console.error(HELP); return 2;
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
