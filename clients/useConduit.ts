/**
 * useConduit — a React hook over the Conduit gateway (bin/conduit-serve.ts).
 *
 * Gives a component the three things an AI feature needs: the streaming assistant
 * text, the raw canonical events (tool calls, thinking, usage), and run/cancel
 * controls. Subscription-as-a-runtime in ~5 lines of UI code:
 *
 *   const { text, run, running, cancel } = useConduit({ provider: "codex" });
 *   <button onClick={() => run("summarize this repo")} disabled={running}>Ask</button>
 *   <pre>{text}</pre>
 *
 * Depends only on conduit-client.js (zero deps). Drop both files in your app.
 */

import { useCallback, useRef, useState } from "react";
import { conduitRun } from "./conduit-client.js";

/** One normalized event from the gateway (see src/canonical.ts for the full union). */
export interface ConduitEvent {
  kind: string;
  text?: string;
  toolName?: string;
  errorKind?: string;
  message?: string;
  [k: string]: unknown;
}

export interface UseConduitOptions {
  /** Provider id (e.g. "claude" / "codex"). Omit to use the gateway's default (first signed-in CLI). */
  provider?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
  enableTools?: boolean;
  token?: string;
}

export function useConduit(opts: UseConduitOptions) {
  const [text, setText] = useState("");
  const [events, setEvents] = useState<ConduitEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (prompt: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setText("");
      setEvents([]);
      setError(null);
      setRunning(true);
      try {
        const result = await conduitRun({
          baseUrl: opts.baseUrl,
          provider: opts.provider,
          model: opts.model,
          cwd: opts.cwd,
          enableTools: opts.enableTools,
          token: opts.token,
          prompt,
          signal: controller.signal,
          onEvent: (e: ConduitEvent) => {
            setEvents((prev) => [...prev, e]);
            if (e.kind === "assistant_text" && typeof e.text === "string") {
              setText((prev) => prev + e.text);
            }
          },
        });
        if (!result.ok) setError(result.error ?? "run failed");
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setRunning(false);
      }
    },
    [opts.baseUrl, opts.provider, opts.model, opts.cwd, opts.enableTools, opts.token],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { text, events, running, error, run, cancel };
}
