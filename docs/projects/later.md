# Later

Wanted, not scheduled.

- **An MCP surface over the message bus.** The same core the CLI calls, exposed
  as tools, so bodies stop being shell-escaped and the verbs get real argument
  schemas. Waiting on the protocol to stop moving; see
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §4 for why the CLI goes
  first.
- **Re-aim the chat frontends at the team.** `src/telegram/` and `src/discord/`
  already put a human in front of a `trip` session from anywhere. Pointed at a
  team they become the remote window on it: the roster and status, a tail of any
  teammate, mail sent as the human, and a push the moment a result lands in the
  coordinator's inbox. Held until the bus protocol settles, so the frontends are
  written once.
- **`agent-sdk` as a headless teammate backend.** Roles that never need a
  terminal could run through [agent-sdk](https://github.com/ninjudd/agent-sdk)
  instead of a PTY, behind the same mail interface. Cheaper per teammate, at the
  cost of the thing that makes this design worth having — see
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §11.
- **Teach trip's codex parser `custom_tool_call`.** Codex records shell
  execution as `response_item`/`custom_tool_call` named `exec`;
  `parse_codex_line` handles only `function_call`, `function_call_output` and
  `reasoning`, so shell calls emit no `agent_tool_call` and the waiting status
  is underivable for Codex teammates — see
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §6.
- **`--size` on `trip create`.** The PTY opens at a hardcoded 80x24. Both TUIs
  cope and attaching resizes it, so this waits until it actually annoys someone.
  See [`trip-primitives.md`](../trip-primitives.md).
