/**
 * path.ts — shared login-shell PATH + binary resolution for provider adapters.
 *
 * A spawned subprocess inherits a minimal PATH that frequently omits the dirs
 * where `claude`/`codex` actually live ("works in my terminal, fails when
 * spawned"). We ask the user's login shell for its interactive-login PATH so every
 * adapter resolves binaries the same way. Bounded by a timeout; falls back to the
 * process PATH. Factored out of claude.ts so codex.ts reuses it without importing
 * the Claude adapter.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter as PATH_DELIMITER, join } from "node:path";
import { access, constants as FS } from "node:fs/promises";

const execFileAsync = promisify(execFile);

let loginPathCache: string | undefined;

/**
 * Resolve the user's *login-shell* PATH (not the bare spawn env). Cached after the
 * first call. Bounded by a 4s timeout; falls back to `process.env.PATH`.
 */
export async function resolveLoginShellPath(): Promise<string> {
  if (loginPathCache !== undefined) return loginPathCache;
  const fallback = process.env.PATH ?? "";
  const shell = process.env.SHELL;
  if (!shell) {
    loginPathCache = fallback;
    return fallback;
  }
  try {
    const { stdout } = await execFileAsync(shell, ["-lic", "echo $PATH"], {
      timeout: 4000,
      encoding: "utf8",
    });
    const resolved = stdout.trim();
    loginPathCache = resolved.length > 0 ? resolved : fallback;
  } catch {
    loginPathCache = fallback;
  }
  return loginPathCache;
}

/**
 * Build the child process env for a spawned agent turn, in ONE place so both adapters
 * stay in lockstep. Starts from the full parent env, OVERRIDES PATH with the
 * login-shell PATH (with any `extraPathDirs` PREPENDED so they shadow real binaries —
 * this is how the generated `basics-store` wrapper wins resolution), and merges any
 * `envOverrides` (e.g. BASICS_STORE_DB, BASICS_DATA_GUIDANCE) last.
 */
export function buildChildEnv(opts: {
  loginPath: string;
  extraPathDirs?: string[];
  envOverrides?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const dirs = (opts.extraPathDirs ?? []).filter((d) => d && d.length > 0);
  const path = dirs.length > 0 ? [...dirs, opts.loginPath].join(PATH_DELIMITER) : opts.loginPath;
  return {
    ...process.env,
    PATH: path,
    ...(opts.envOverrides ?? {}),
  };
}

/** Locate a named binary across the login-shell PATH. Returns null if absent. */
export async function resolveBinaryOnLoginPath(
  name: string,
): Promise<string | null> {
  const path = await resolveLoginShellPath();
  for (const dir of path.split(PATH_DELIMITER)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, FS.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}
