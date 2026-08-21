# The trip primitives tripping builds on

[trip](https://github.com/ninjudd/trip) owns persistent PTY sessions. tripping
adds a message bus and an orchestrator on top of it, and uses six of trip's
primitives to do it. This document records what each one gives you and the
source facts the design depends on, so a change to trip that breaks one of them
is recognisable as such.

## Session primitives

| Command | What you get |
|---|---|
| `trip create <name> -- cmd` | A detached session. It inherits the caller's working directory and environment, and it outlives the process that created it. |
| `trip send <name> <text>` | Input injected into any session. You do not need to be the writer. |
| `trip log <name> --raw --follow` | The session's structured event stream. |
| `trip screen <name>` | The current screen, without attaching. |
| `trip attach <name>` | A human takes the wheel, at any moment, on any agent. |
| `trip kill <name>` | The session ends. |

Use `trip create` plus `trip log --follow` for anything long-lived. Do not use
`trip wrap`: it ties the session's lifetime to the wrapping process, which is
correct for an ephemeral viewport and wrong for a teammate that should survive
the orchestrator restarting.

## Normalized agent events

`daemon/agent.rs` tails a registered agent's own JSONL log and normalizes it
into one vocabulary, identically for Claude Code and Codex:

`agent_session_start`, `agent_session_end`, `agent_text`, `agent_thinking`,
`agent_tool_call`, `agent_tool_result`, `agent_activity`, `agent_turn_end`

`agent_turn_end` is the one that matters most. It is an engine-agnostic
**liveness signal**: you can tell whether an agent is working or idle without
parsing a TUI. Deriving that from screen scraping is normally the hardest part
of building an orchestrator on PTYs, and trip has already done it.

Events land in `~/.trip/sessions/<name>/log.jsonl`. Read the tail of that file
to derive an agent's status; you do not need a running watcher, and there is no
status file to go stale.

## Registering an agent

Agent events only appear after `trip on` runs inside the session. It reads
`TRIP_SESSION`, locates the agent's log from `CLAUDE_CODE_SESSION_ID` or
`CODEX_THREAD_ID`, and writes `~/.trip/sessions/<name>/agent.json`.

Most setups run it from a `SessionStart` hook. Everything tripping derives about
an agent's state depends on it, so treat a missing `agent.json` as a spawn
failure rather than a degraded mode.

## Two source facts the design rests on

**Spawned sessions get the caller's environment.** `Session::spawn` builds the
child's environment from only the map in the request (`session.rs:96`) — it does
not inherit the daemon's. `trip create` passes `terminal_env()`, which is the
client process's full environment (`client/mod.rs:13`). So a session created by
tripping inherits `PATH`, `HOME`, and credentials, and tripping can pass
`TRIPPING_TEAM` and `TRIPPING_AGENT` by setting them on its own spawn.

**`TRIP_SESSION` is always correct inside a session.** The daemon force-sets it
to the session name and filters any inherited value out of the map first
(`session.rs:84-88`). So `trip on` resolves the right session even when the
spawning process was itself inside a different one.

## Constraints to design around

`trip create` opens the PTY at a hardcoded 80x24 (`daemon/mod.rs:215`). Both
agent TUIs render at that size, and the PTY resizes when a human attaches, so
this is a papercut rather than a blocker. Adding `--size` to `trip create` is
the fix if it becomes one.

Session names become directory names under `~/.trip/sessions/`, and trip appends
`.1`, `.2` to auto-number. Keep `.` and `/` out of any name tripping generates.

`trip send` appends Enter unless you pass `--raw`.
