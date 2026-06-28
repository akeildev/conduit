# Claude Code stream-json fixtures

Real captures from Claude Code v2.1.195 via:

```
claude -p "<prompt>" --output-format stream-json --verbose --allowedTools ""
```

- `plain_text.jsonl` — a one-turn text reply. Native line types, in order:
  `system`(subtype `init`) → `assistant` (one `text` block in `message.content[]`) →
  `rate_limit_event` → `result` (subtype `success`, `is_error:false`, `usage`, `total_cost_usd`).

Canonical backbone the adapter must produce (significant kinds only):
`assistant_text`, `final_result` — with `system_message` (session start) and a
`session_status{status:"rate_limit"}` ping around them.

No secrets in these files (session_id is a throwaway UUID; no tokens/keys). Tool-call /
tool-result block shapes (`tool_use` in an `assistant` line, `tool_result` in a `user`
line) are covered by the parse unit tests with inline shapes.
