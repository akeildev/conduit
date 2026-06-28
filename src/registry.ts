/**
 * registry.ts — the provider registry + bounded detection.
 *
 * Conduit drives any number of provider adapters through one contract. This module
 * holds the BUILT-IN adapters (here: the hand-written Codex adapter as a worked
 * reference) plus a runtime-registration list — the "bring your own CLI" seam that
 * `defineGenericCli` specs and the manifest loader append to. A built-in id always
 * wins over a same-id registration.
 */

import { codexAdapter } from "./codex.ts";
import { claudeAdapter } from "./claude.ts";
import type { DetectResult, ProviderAdapter } from "./types.ts";

/** The built-in, hand-written provider adapters shipped with Conduit. */
export const ADAPTERS: readonly ProviderAdapter[] = [claudeAdapter, codexAdapter];

/** Runtime-registered providers (generic/config-driven or host-supplied). */
const registered: ProviderAdapter[] = [];

/**
 * Register an additional provider adapter (idempotent per id; a built-in id cannot be
 * shadowed). Returns true if added/updated, false if a built-in already owns the id.
 */
export function registerProvider(adapter: ProviderAdapter): boolean {
  if (ADAPTERS.some((a) => a.id === adapter.id)) return false;
  const idx = registered.findIndex((a) => a.id === adapter.id);
  if (idx >= 0) registered[idx] = adapter;
  else registered.push(adapter);
  return true;
}

/** Remove a runtime-registered provider by id (no effect on built-ins). */
export function unregisterProvider(id: string): void {
  const idx = registered.findIndex((a) => a.id === id);
  if (idx >= 0) registered.splice(idx, 1);
}

/** Every adapter Conduit can drive right now: built-ins, then runtime registrations. */
export function allAdapters(): readonly ProviderAdapter[] {
  return [...ADAPTERS, ...registered];
}

/** Look up an adapter by id (built-in or runtime-registered). */
export function getAdapter(id: string): ProviderAdapter | undefined {
  return allAdapters().find((a) => a.id === id);
}

/** Max time to wait on a single adapter's detect() before falling back. */
const DETECT_TIMEOUT_MS = 6000;

/**
 * Detect every adapter, in parallel, each bounded by a timeout. A hung `detect()` never
 * blocks the result: it resolves to a typed not-found rather than stalling the batch.
 */
export async function detectAgents(): Promise<DetectResult[]> {
  return Promise.all(allAdapters().map((adapter) => detectOne(adapter)));
}

async function detectOne(adapter: ProviderAdapter): Promise<DetectResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DetectResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ id: adapter.id, found: false, authenticated: false, detail: "detection timed out" });
    }, DETECT_TIMEOUT_MS);
  });
  try {
    const detect = adapter.detect().catch(
      (): DetectResult => ({ id: adapter.id, found: false, authenticated: false, detail: "detection failed" }),
    );
    return await Promise.race([detect, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
