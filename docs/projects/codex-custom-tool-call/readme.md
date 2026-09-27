---
status: draft
priority: later
---

# Teach trip's codex parser `custom_tool_call`

In flight, not merely wanted: [trip#3](https://github.com/ninjudd/trip/pull/3)
is open. Codex records shell execution as `response_item`/`custom_tool_call`
named `exec`; `parse_codex_line` handles only `function_call`,
`function_call_output` and `reasoning`, so shell calls emit no
`agent_tool_call` and the waiting status is underivable for Codex teammates.
tripping's matcher already handles the `exec` shape, so the status starts
deriving the moment that lands — see [`agent-orchestrator.md`](../agent-orchestrator/readme.md) §6.

The work is in trip rather than here, so this project stays `draft`: nothing in
tripping changes when it lands.

This entry carries its line from `later.md` before the Projector migration.
No plan yet; write it here when the work graduates.
