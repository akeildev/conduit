/**
 * conduit/manifest.ts — "Subscription as a Runtime": load + register BYO-CLI specs.
 *
 * Conduit is the runtime that turns ANY agent CLI a user already pays for (their
 * Claude / Codex / other subscription) into the engine that drives the app. The
 * built-in providers (claude, codex, hermes) are hand-written; this module is the
 * CONFIG path: a `ConduitManifest` is a JSON document listing {@link GenericCliSpec}s,
 * and registering it brings each CLI online via `defineGenericCli` + `registerProvider`
 * — no code change, no rebuild.
 *
 * This is the Basics analog of the studied reference's `cli-deps.json` (Houston pins
 * each CLI's binary + version + checksum), EXTENDED with the one thing Houston's file
 * does not carry: the declarative line→canonical-event PARSE mapping (there, parsing
 * is hand-written `match provider.id()` arms). So a Conduit manifest entry says BOTH
 * how to run the CLI AND how to read its stream. No reference code is imported.
 *
 * Bundling/pinning (download URL + sha256 + per-arch staging, à la cli-deps.json) is a
 * deployment concern intentionally left to the host/installer; a manifest entry may
 * carry an advisory `version`/`source` for display, but Conduit resolves the binary off
 * the user's login-shell PATH (BYO subscription = the user's own already-installed CLI).
 */

import { readFileSync } from "node:fs";
import { defineGenericCli, type GenericCliSpec } from "./generic.ts";
import { registerProvider } from "./registry.ts";
import type { ProviderAdapter } from "./types.ts";

/** A Conduit manifest: a versioned list of BYO-CLI specs. */
export interface ConduitManifest {
  /** Manifest schema version (additive evolution only). */
  version: number;
  /** The CLIs this deployment brings online declaratively. */
  clis: GenericCliSpec[];
}

/** The result of registering one manifest. */
export interface ConduitRegisterResult {
  /** Provider ids newly registered. */
  registered: string[];
  /** Provider ids skipped because a built-in already owns the id. */
  skipped: string[];
}

/** Minimal structural validation — enough to fail loudly on a malformed manifest, never throws blindly. */
function assertSpec(spec: unknown, index: number): asserts spec is GenericCliSpec {
  const where = `clis[${index}]`;
  if (!spec || typeof spec !== "object") throw new Error(`Conduit manifest ${where}: not an object`);
  const s = spec as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.length === 0) throw new Error(`Conduit manifest ${where}: missing "id"`);
  if (typeof s.binary !== "string" || s.binary.length === 0) throw new Error(`Conduit manifest ${where}: missing "binary"`);
  if (!s.argv || typeof s.argv !== "object") throw new Error(`Conduit manifest ${where}: missing "argv"`);
  const argv = s.argv as Record<string, unknown>;
  if (!argv.prompt || typeof argv.prompt !== "object") throw new Error(`Conduit manifest ${where}: missing "argv.prompt"`);
  if (!s.mapping || typeof s.mapping !== "object") throw new Error(`Conduit manifest ${where}: missing "mapping"`);
  const mapping = s.mapping as Record<string, unknown>;
  if (!Array.isArray(mapping.rules)) throw new Error(`Conduit manifest ${where}: "mapping.rules" must be an array`);
}

/**
 * Register every CLI in a parsed manifest. Each becomes a {@link ProviderAdapter} via
 * `defineGenericCli`, then is appended to the registry through `registerProvider` (a
 * built-in id is never shadowed → it lands in `skipped`). Returns the registered/skipped ids.
 */
export function registerCliManifest(manifest: ConduitManifest): ConduitRegisterResult {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.clis)) {
    throw new Error("Conduit manifest: expected { version, clis: [...] }");
  }
  const result: ConduitRegisterResult = { registered: [], skipped: [] };
  manifest.clis.forEach((spec, i) => {
    assertSpec(spec, i);
    const adapter: ProviderAdapter = defineGenericCli(spec);
    if (registerProvider(adapter)) result.registered.push(spec.id);
    else result.skipped.push(spec.id);
  });
  return result;
}

/** Read a Conduit manifest JSON file and register every CLI in it. Throws on bad JSON/shape. */
export function loadCliManifestFile(path: string): ConduitRegisterResult {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as ConduitManifest;
  return registerCliManifest(parsed);
}
