/**
 * errors.ts — the typed spawn error shared by every adapter.
 *
 * A spawn/argv failure carries a {@link ProviderErrorKind} so the caller can render a
 * typed state (CliNotFound, SpawnFailed, …) instead of a raw stack trace. Defined as an
 * explicit field (not a TS parameter property) so the package runs under Node's native
 * type-stripping, which does not transform parameter properties.
 */

import type { ProviderErrorKind } from "./provider_error.ts";

export class ProviderSpawnError extends Error {
  readonly errorKind: ProviderErrorKind;
  constructor(errorKind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "ProviderSpawnError";
    this.errorKind = errorKind;
  }
}
