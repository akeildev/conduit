# Codex fixtures — native event type → canonical kind

Captured from the real `codex exec --json` CLI (codex-cli **v0.141.0**). The
"every native type accounted for" discipline: every native event type that
appears in these fixtures maps to a canonical kind — nothing falls through to an
`[unmapped …]` / `[unparsed …]` system_message.

| Codex native event                                            | Canonical kind                                  |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `{type:"thread.started", thread_id}`                          | `system_message` ("Session started (thread=…)") |
| `{type:"turn.started"}`                                       | `session_status` `{status:"turn_started"}`      |
| `{type:"item.started",   item.type:"command_execution"}`      | `tool_call`                                      |
| `{type:"item.completed", item.type:"command_execution"}`      | `tool_result` (isError = exit_code != 0)        |
| `{type:"item.completed", item.type:"agent_message"}`          | `assistant_text`                                |
| `{type:"item.completed", item.type:"reasoning"}` (defensive)  | `thinking`                                       |
| `{type:"item.started",   item.type:"agent_message"|reasoning}`| `[]` (codex sends final items, not deltas)      |
| `{type:"item.updated", …}` (future codex)                     | `[]` (accounted-for)                            |
| `{type:"turn.completed", usage}`                              | `final_result` (costUsd:0 — BYO unmetered)      |
| `{type:"turn.failed", error}`                                 | `provider_error` (classified)                   |
| `{type:"error", message}`                                     | `provider_error` (classified)                   |
| `<unknown type / unknown item.type / non-JSON>`               | `system_message` (typed, never throws/drops)    |

## Fixtures

- `plain_text.jsonl` — REAL text turn capture (thread.started, turn.started,
  item.completed/agent_message, turn.completed).
- `tool_use.jsonl` — REAL tool turn capture (adds item.started + item.completed
  command_execution, a second agent_message).
- `error_rate_limit.jsonl` — synthesized with the EXACT real shape: an
  `{type:"error", message:"{…status:429…}"}` + `{type:"turn.failed", …}` pair.
  Codex's `message` is a JSON STRING; classifies to `RateLimited` (retryable).
- `error_auth.jsonl` — same shape with status 401 / `authentication_error`;
  classifies to `Unauthenticated`.

`final_result` is covered by the real captures (`turn.completed`).

## Significant-kind backbone (cross-provider conformance)

Filtering each fixture to the significant-kind backbone (assistant_text,
thinking, tool_call, tool_result, final_result, provider_error,
context_compacted — dropping delta/status classes AND session-init
`system_message`):

- `plain_text.jsonl` → `assistant_text, final_result`
  (parallel to claude `turn1_text.ndjson`).
- `tool_use.jsonl` → `assistant_text, tool_call, tool_result, assistant_text, final_result`
  (parallel to claude `turn2_tools.ndjson`).
