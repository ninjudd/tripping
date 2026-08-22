# tripping

*Ping your trip sessions.*

Agent orchestration on top of [trip](https://github.com/ninjudd/trip). A
coordinator — Claude Code or Codex, running in a real terminal — spawns
teammates, each its own CLI in its own [trip](https://github.com/ninjudd/trip)
session, and they talk over a durable on-disk message bus.

Every agent is a real PTY session, so `trip attach` puts a human at any
teammate's keyboard mid-task, and `trip log` replays what it did. Nothing is
hidden behind an SDK.

```
$ trip team start mycrew                    # launch the coordinator
$ trip team spawn api --role "the API"      # …which spawns teammates
$ trip team spawn ui --engine codex --role "the UI"
$ trip team ls
team mycrew — 2/4 teammates live (limits: team.json)
  api            claude working  age 2m   spawns 1   1 in / 0 held / 0 dead  the API
  ui             codex  waiting  age 2m   spawns 1   0 in / 1 held / 0 dead  the UI
```

Claude and Codex teammates work side by side on the same team; the bus does
not care which engine is behind an id.

## How it works

**The inbox is the transport.** Messages are files under
`~/.trip/teams/<team>/agents/<id>/`, moved between `inbox/`, `working/`,
`archive/` and `dead/` by atomic rename. No locks, no daemon, no database —
`ls` is the debugger, and an agent's mail survives its own restart.

**The terminal is the doorbell.** `trip send` is used only to wake an idle
teammate that has mail waiting. Content never rides the PTY.

**Blocking is the point.** A teammate ends its turn inside
`trip message wait`, so the next message arrives as a tool *result* and it
simply keeps going, rather than idling until something types at it.

**Status is derived, never stored.** `trip team ls` reads the tail of each
session's event log. There is no status file to go stale.

## Commands

```
trip team start <name>          launch a coordinator for a new team
trip team spawn <id> --role …   add a teammate  [--engine claude|codex]
                                                [--worktree] [--yolo]
                                                [--model m] [--effort e]
trip team ls                    who is on the team, and what they are doing
trip team dispatch <f> --wait   fan tasks out, block until every result lands
trip team watcher               reconcile: respawn the dead, ring doorbells
trip team respawn <id>          restart a teammate, preserving its work
trip team requeue <id> <task>   revive a dead-lettered task
trip team kill <id>             end a teammate

trip message send <to> …        --kind task|result|question|note, --subject,
                                --thread; body on stdin
trip message read               claim what is waiting
trip message peek               look without claiming
trip message wait               block until mail arrives
```

`trip message` takes the sender's identity from `TRIP_TEAM` and `TRIP_AGENT`
in the environment, never from a flag, so an agent cannot send as someone
else.

## Install

```
npm install && npm run build && npm link
```

This puts `trip-team` and `trip-message` on `PATH`; trip dispatches
`trip team …` to them the way git dispatches to `git-<verb>`.

The package ships a plugin in `plugin/`, passed to each teammate at launch. It
carries the `SessionStart` hook that runs `trip on` — without which no agent
events are logged and no status can be derived — and the `trip-team` skill
that teaches the message protocol. Nothing is written to your global Claude or
Codex configuration.

## Autonomy

Every teammate launches with a tier. The default is `auto`
(`--permission-mode auto` / `--approve-for-me`); `--yolo` is
`--permission-mode bypassPermissions` /
`--dangerously-bypass-approvals-and-sandbox`. There is no interactive tier —
an unattended agent cannot answer a prompt.

The watcher never types into a screen that looks like a permission dialog. If
one appears it tells the coordinator and leaves it for a human.

## Chat frontends

Telegram and Discord bridges to plain trip sessions live in `src/telegram/`
and `src/discord/` and are out of scope for v1. `npm run telegram` /
`npm run discord`, with a token in `.env` — see `.env.example`.

## Requirements

- [trip](https://github.com/ninjudd/trip) installed and on PATH
- Node.js 18+
- Claude Code and/or Codex on PATH

## Documentation

- [`docs/trip-primitives.md`](docs/trip-primitives.md) — the trip guarantees
  this builds on, and the source facts behind each one.
- [`docs/projects/`](docs/projects/) — the work itself.
  [`agent-orchestrator.md`](docs/projects/all/agent-orchestrator.md) is the
  design: the message model, status derivation, spawning, task custody,
  population limits, and the decisions behind them.
