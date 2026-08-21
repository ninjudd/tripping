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

One thing the events cannot tell you is liveness. `agent_session_end` is
emitted only when the tailer exits because `agent.json` was removed or
replaced (`daemon/agent.rs:277-287`) — a CLI that is killed or crashes never
logs one, and the tailer keeps polling the dead transcript. Whether a session
is alive comes from the daemon's session list, which marks a session Exited on
SIGCHLD and reaps it once no client is attached (`daemon/mod.rs:165-167`);
never infer death from the log tail or from silence.

## Registering an agent

Agent events only appear after `trip on` runs inside the session. It resolves
the agent's kind and log path in this order, then writes
`~/.trip/sessions/<name>/agent.json`:

1. JSON on stdin carrying `transcript_path` — how a `SessionStart` hook calls
   it (`client/mod.rs:624`, `client/mod.rs:657-672`).
2. `CLAUDE_CODE_SESSION_ID` in the environment.
3. `CODEX_THREAD_ID` in the environment.

**The hook path hardcodes the kind to `codex`** (at trip `6955ad1`). Claude
Code's `SessionStart` hook passes exactly that JSON — and the hook is the setup
trip's own README recommends — so a Claude agent registered through it gets an
`agent.json` claiming `codex` against a Claude transcript. The codex parser
keys on `session_meta` / `event_msg` / `response_item` (`daemon/agent.rs`),
none of which a Claude transcript contains, so zero agent events follow, while
`agent.json` exists and an existence check passes. The durable fix belongs in
trip; until it lands, anything spawning Claude agents must verify that the
`kind` in `agent.json` matches the engine and repair it when it does not — by
removing `agent.json` and writing it back corrected, never by editing it in
place. The daemon's tailer captures the config once (`daemon/agent.rs:237`)
and its per-tick re-read compares only `log_path` (`agent.rs:249-253`), so an
in-place `kind` edit changes nothing it watches. Removal makes the tailer
exit — but only once it *observes* the removal: it re-checks every 300ms
(`agent.rs:274`), and a rewrite that lands inside that window restores a file
with the same `log_path`, so the tailer never sees `None` and never exits.
Leave `agent.json` absent for longer than the poll before writing it back
(or verify events start flowing and retry). Once the old tailer exits, the
watcher re-enters within its 2s tick (`daemon/session.rs:187-194`) with a
fresh read, and because the new tailer starts at offset 0 (`agent.rs:244`)
the transcript is re-parsed from the top — the events the wrong parser
dropped are recovered rather than lost. The `log_path` the hook
discovered is correct either way.

Everything tripping derives about an agent's state depends on registration, so
treat a missing `agent.json` as a spawn failure rather than a degraded mode —
and a wrong `kind` as the same failure wearing a healthier look.

## Two source facts the design rests on

**Spawned sessions get the caller's environment.** `Session::spawn` builds the
child's environment from only the map in the request (`session.rs:83-89`) and
hands it to `execve` (`session.rs:138`), which replaces the environment
outright rather than inheriting the daemon's. `trip create` passes
`terminal_env()`, which is the client process's full environment
(`client/mod.rs:13`). So a session created by tripping inherits `PATH`,
`HOME`, and credentials, and tripping can pass `TRIPPING_TEAM` and
`TRIPPING_AGENT` by setting them on its own spawn.

**`TRIP_SESSION` is always correct inside a session.** The daemon force-sets it
to the session name and filters any inherited value out of the map first
(`session.rs:84-88`). So `trip on` resolves the right session even when the
spawning process was itself inside a different one.

## Constraints to design around

`trip create` opens the PTY at a hardcoded 80x24 (`daemon/mod.rs:215`). Both
agent TUIs render at that size, and the PTY resizes when a human attaches, so
this is a papercut rather than a blocker. Adding `--size` to `trip create` is
the fix if it becomes one.

Session names become directory names under `~/.trip/sessions/` (`common.rs:16`),
so keep `.` and `/` out of any name tripping generates — `trip new` and
`trip wrap` append `.1`, `.2` to whatever base they are given, explicit or
derived (`client/mod.rs:188-195`; `wrap.rs:181-188` reuses a bare name only
when it already exists and no command was given). `trip create` does not: a
name that already exists is a hard error (`daemon/mod.rs:204-213`). An exited
session is reaped only once no client is attached (`daemon/mod.rs:165-167`),
so re-creating a name after a crash may need an explicit `trip kill` first.

`trip kill` on a live name sends SIGHUP and removes the session from the
daemon's map unconditionally (`daemon/mod.rs:576-592`), so the name frees
immediately; on a missing name it errors with "session not found", which
respawn paths tolerate.

`trip send` appends Enter unless you pass `--raw`.
