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
  teammate, messages sent as the human, and a push the moment a result lands
in the
  coordinator's inbox. Held until the bus protocol settles, so the frontends are
  written once.
- **`agent-sdk` as a headless teammate backend.** Roles that never need a
  terminal could run through [agent-sdk](https://github.com/ninjudd/agent-sdk)
  instead of a PTY, behind the same message interface. Cheaper per teammate, at
the
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
- **Teammates spawning sub-teams.** Rejected for v1 —
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §16: every mechanism
  from the result loop to the doorbell to branch integration assumes a
  one-level team, and the escalation path costs one message. A real sub-team
  design needs routing, doorbell, and integration rules of its own.
- **Transcript-parsing usage recorders.** Claude's usage fields and Codex's
  token-count events are both dropped by trip's normalizer today. A recorder
  would be observability only —
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §11 records why
  enforcement is refused permanently.
- **`trip ls --json`.** A machine-readable session list would let tripping
  check liveness against the daemon without parsing human-formatted output;
  until then `spawn.ts` shells out to `trip ls -a` and tolerates format
  drift.
- **A failed spawn leaves its session and roster row behind — and the failure
  can be a false negative.** `spawnTeammate` writes the roster row and calls
  `trip create` before waiting on registration, so a registration failure
  throws with the session live and the row written. The teammate name stays
  held and the next `trip team spawn` refuses it as already live.

  **Check before you kill.** `verifyAgentRegistration` polls for 15 seconds. A
  writer parks at its engine's trust dialog before it can register, and a
  human takes longer than that to answer, so the throw fires and the teammate
  registers immediately afterwards and gets to work. On the writer path the
  timeout is *expected* to lose, not unlucky — observed in §19. Run
  `trip team ls` first: a teammate that registered late reads `working` or
  `waiting`, and only a genuinely absent one is flagged `gone?`. Killing on
  the error alone destroys a healthy teammate mid-task along with whatever it
  has not committed.

  The fix is to unwind both on failure, or to say in the error which case it
  is — the spawn can tell, since it can read the screen. A blindly longer
  timeout is the weaker option: 15 seconds is a bet that no human is involved,
  and the right answer is to notice when one is. See
  [`agent-orchestrator.md`](all/agent-orchestrator.md) §7 and §19.
- **Writer worktrees land where neither engine trusts them.** §7 puts them at
  `~/.trip/teams/<team>/wt/<id>`, and both Claude and Codex gate an untrusted
  directory behind a prompt the teammate cannot answer — so every writer
  parks at startup, before it registers, and stays parked until a human
  attaches. Codex's dialog matches none of §8's text signatures, so the
  selector glyph is the only thing that detects it at all.

  The fix looks cheap: both engines inherit trust from an enclosing trusted
  repository, and a **git worktree inside that repository** passes for both —
  verified against real sessions of each, including the worktree case, where
  the `.git` file might have made it a separate project and does not. Codex
  does treat a nested `git init` repository as its own project and prompts
  for it, so the distinction that matters is worktree-inside-the-repo versus
  independent-checkout-elsewhere. Siting them at `<repo>/.tripping/wt/<id>`
  would sidestep the dialog entirely, at the cost of worktrees living in the
  operator's checkout, which §15's pathspec work was careful to avoid.
  tripping must not grant trust on the operator's behalf by editing their
  config — attempting it here was correctly blocked.
  See [`agent-orchestrator.md`](all/agent-orchestrator.md) §7.
