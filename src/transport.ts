/**
 * transport.ts — the shared line-delimited transport helper.
 *
 * The widened `ProviderAdapter` contract (see types.ts FORWARD-NOTE) makes
 * `readEvents(child, ctx): AsyncIterable<CanonicalEvent>` the event SOURCE the bus
 * consumes. For BOTH Phase-1 providers (Claude `stream-json`, `codex exec --json`)
 * that source is the same shape: newline-delimited JSON on the child's stdout,
 * each line folded through the adapter's `parseLine`. This module factors that fold
 * into one place so each adapter's `readEvents` is a one-liner that delegates here.
 *
 * A JSON-RPC-over-stdio provider (`codex app-server`, P6's Hermes-over-ACP) would
 * implement `readEvents` WITHOUT this helper — as a request/notification
 * correlator — which is exactly why the contract is `readEvents`, not `parseLine`.
 *
 * Buffering: stdout `data` chunks do not respect line boundaries, so we buffer and
 * split on "\n", holding the trailing partial until the next chunk (or stream end).
 */

import type { Readable } from "node:stream";
import type {
  CanonicalEvent,
  EnvelopeContext,
} from "./canonical.ts";
import type { SpawnedProcess } from "./types.ts";

/** The per-line mapper an adapter supplies (its `parseLine`). MUST NOT throw. */
export type LineMapper = (
  line: string,
  ctx: EnvelopeContext,
) => CanonicalEvent[];

/**
 * Turn a child's stdout into an `AsyncIterable<CanonicalEvent>` by buffering
 * newline-delimited lines and folding each through `parseLine`. This is the
 * line-provider implementation of the `readEvents` contract; both P1 adapters use
 * it. The flush after stream end re-runs any trailing partial line through the
 * mapper (the mapper degrades a partial/garbage tail to a typed event, never throws).
 */
export async function* linesToEvents(
  child: SpawnedProcess,
  ctx: EnvelopeContext,
  parseLine: LineMapper,
): AsyncIterable<CanonicalEvent> {
  const stdout: Readable = child.stdout;
  stdout.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += chunk as string;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* parseLine(line, ctx);
    }
  }
  // Flush a trailing partial (no terminating newline at stream end).
  if (buffer.length > 0) {
    yield* parseLine(buffer, ctx);
  }
}
