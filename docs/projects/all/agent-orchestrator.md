---
status: Draft
owner: justin.balthrop
---

# Turn tripping into an agent orchestrator

You start a coordinator — Claude or Codex — in a `trip` session. It spawns
teammates, each its own Claude or Codex CLI in its own `trip` session, and
directs them over a durable on-disk message bus.

Every teammate is a real CLI in a real PTY, which is the point: you can
`trip attach` any of them mid-task and take the wheel. An orchestrator built on
an SDK cannot offer that.

The substrate this needs already exists. [`trip-primitives.md`](../../trip-primitives.md)
records what trip gives us and the source facts the design depends on; nothing
in trip has to change to ship this.

## 1. Scope

In: the message bus, the `tripping` CLI, spawning and observing teammates, and
a worked proof of a coordinator running two teammates to completion.

Out: the chat frontends. `src/telegram/` and `src/discord/` stay untouched until
the protocol settles, so they get rewritten once rather than twice. They are on
[`later.md`](../later.md), along with an MCP surface and a headless backend.

## 2. Why the inbox and the doorbell are both needed

The obvious two options — pass messages over the PTY, or keep an inbox on
disk — are not alternatives. They solve different halves of the problem:

| | PTY (`trip send`) | Inbox (disk) |
|---|---|---|
| Durable, re-readable after a compaction | no | yes |
| Ordered, addressed, threaded | no | yes |
| Large or structured payloads | no — the TUI mangles them | yes |
| Wakes an idle agent | yes | no |
| Safe while the agent is mid-turn | racy | yes, queues cleanly |

So the inbox is the transport and the PTY is the doorbell. Content goes to disk;
a one-line `trip send` tells an idle agent to go read it. Never push a task spec
through a TUI input box — it arrives escaped, it interacts with whatever the TUI
currently has focused, and it is gone the moment the agent compacts.

## 3. The two wake mechanisms

**Blocking wait, the primary one.** A teammate's last action in every turn is
`tripping mail wait`, which blocks. The agent stays inside a tool call rather
than going idle, so the next message arrives as a tool *result* — no injection,
no race, no escaping. This is the steady-state loop, and it means most messages
never touch a PTY at all.

**The doorbell, for everything else.** An agent that has genuinely gone idle,
and out-of-band control like a stop or a priority interrupt, need
`trip send <session> "..."`. Because `agent_turn_end` tells us who is idle
(§6), we only ring when it is safe to.

## 4. The `tripping` CLI

One binary, subcommand groups, shipped through a `bin` entry in `package.json`.
Nothing else goes on `PATH` for an agent to confuse with `trip` itself.

Identity comes from `TRIPPING_TEAM` and `TRIPPING_AGENT` in the environment, so
there is no `--from` flag anywhere and an agent cannot post as someone else by
accident.

`tripping mail` is what every teammate uses. It is the whole surface an LLM has
to learn, so it stays at four verbs:

```
tripping mail send <to> --subject S [--kind task] [--thread T]   # body on stdin
tripping mail read                  # print unread, archive them
tripping mail peek                  # print unread, leave them
tripping mail wait [--timeout 550]  # block until mail arrives
```

`tripping team` is what the coordinator uses; teammates normally do not:

```
tripping team init <name>
tripping team spawn <id> --role "..." [--engine claude|codex] [--worktree]
tripping team ls                     # roster + derived status
tripping team kill <id>
tripping team watch <id>             # tail a teammate's structured log
tripping team dispatch <file> --wait # fan out tasks, block until all results
```

`--wait` is sugar over the same primitives, for when the coordinator wants
deterministic fan-out and fan-in rather than a reactive mailbox loop.

A CLI rather than an MCP server, for now: one implementation serves both
engines, you can drive it by hand from any shell to debug a stuck team, and
there is no per-engine MCP config to bootstrap on every spawn. An MCP surface
over the same core is worth having once the protocol stops moving, and it is on
[`later.md`](../later.md).

## 5. Message model

The bus is a maildir, because atomic-create-by-rename and atomic-claim-by-rename
mean no locking, no partial reads, and `ls` is the debugger.

```
~/.tripping/teams/<team>/
  team.json                 roster: id, role, engine, session, cwd, worktree, branch
  bus.jsonl                 append-only audit of every message
  tmp/                      staging for atomic writes
  agents/<id>/inbox/        <msg-id>.json — unread
  agents/<id>/archive/      read
  artifacts/                large payloads, referenced by path from a message
  wt/<id>/                  git worktree, for roles that write
```

To send, write `tmp/<id>.json` and `rename` it into the recipient's `inbox/`. To
claim, `rename(inbox/x, archive/x)` — atomic, so two readers cannot both take
the same message.

The envelope stays small:

```json
{
  "id":        "01K5...",      // sortable by time, so ls gives you order
  "from":      "worker-1",
  "to":        "coordinator",
  "kind":      "task | result | question | answer | note | control",
  "thread":    "01K5...",      // correlation id
  "reply_to":  "01K5...",
  "subject":   "one line",
  "body":      "markdown",
  "artifacts": ["artifacts/diff-01K5.patch"],
  "ts":        1755823000
}
```

`kind` drives doorbell policy and decides whether a blocking join is satisfied.
Anything large goes in `artifacts/` and is referenced, not inlined.

## 6. Status derivation

Read the tail of `~/.trip/sessions/<name>/log.jsonl` on demand. This is
stateless: no status file to go stale when the orchestrator is not running, and
no watcher required to answer `tripping team ls`.

The log outlives the session. `log.jsonl` is opened append-only and the session
directory is never removed, so a respawned `<team>-<id>` appends to its previous
incarnation's log — and between `trip create` and the new agent's first event,
the tail is the old incarnation's `agent_turn_end`, which the table below reads
as idle and §8 answers by ringing a doorbell at a TUI still starting up, the
race §7 step 3 exists to avoid. Events carry only a timestamp — no pid, no run
id — and no CLI surface exposes the session's creation time, so scope every
status read to events after the last `agent_session_start`. Each tailer emits
exactly one, so it marks the current incarnation using nothing beyond the file
already being read, which keeps the stateless property above intact. One
caveat, safe in its direction: a tailer restart re-parses the transcript from
offset 0 and re-emits its `agent_session_start`, which can move the boundary
forward — discarding old events, never admitting them. §13's restart question
lands in the same place and they should be settled together.

| Last agent event | Status |
|---|---|
| `agent_turn_end`, `agent_session_end` | idle |
| `agent_activity`, `agent_text`, `agent_tool_call` | working |
| a `Bash` `agent_tool_call` whose input runs `tripping mail wait`, no result yet | waiting — Claude only |
| none | unknown — `trip on` never fired, or it is a plain shell |

The waiting row is derivable only for Claude teammates today. The tool call's
`name` field is the tool, not the command — `Bash`, with the command inside the
call's `input` — so the derivation inspects the input rather than matching the
name. Codex records shell execution as a `custom_tool_call` named `exec`, which
trip's codex parser currently drops, so a Codex teammate blocked on
`tripping mail wait` keeps reading as working. §8 loses nothing — the doorbell
stays quiet for working and waiting alike — but `tripping team ls` cannot
separate a Codex teammate blocked on mail from one grinding through a task.
Teaching trip's parser `custom_tool_call` closes the gap; it is the first
thing on this plan that would want a trip change, and it is on
[`later.md`](../later.md).

The last row is a spawn failure, not a degraded mode. Everything else here
depends on it, so §7 checks for it explicitly.

## 7. Spawning a teammate

1. For a role that writes: `git worktree add wt/<id> -b team/<team>/<id>`.
   Roles that only read share the repository working directory.
2. Write `wt/<id>/.tripping/PROTOCOL.md` — the messaging contract, identical for
   both engines.
3. `trip create <team>-<id> -- <engine> "<role prompt>"`, spawned from Node with
   `cwd` set to the worktree and `env` carrying `TRIPPING_TEAM` and
   `TRIPPING_AGENT`. The prompt goes in argv. Never type it in afterwards —
   that races the TUI's startup.
4. Check that `~/.trip/sessions/<team>-<id>/agent.json` appeared **and that
   its `kind` matches the engine**. `trip on`'s hook path hardcodes `codex`
   (see [`trip-primitives.md`](../../trip-primitives.md)), so a Claude teammate
   registered through a `SessionStart` hook passes an existence check while
   staying invisible to §6. Repair a wrong `kind` by removing `agent.json` and
   writing it back corrected — an in-place edit is the one change the daemon's
   tailer ignores, while remove-then-write makes it restart with the fixed
   config and re-parse the transcript from the top;
   [`trip-primitives.md`](../../trip-primitives.md) has the mechanics — and
   fail the spawn loudly when the file is missing.

The role prompt ends with the loop:

> When you finish a task, `tripping mail send coordinator --kind result`
> describing what you did, then run `tripping mail wait` to block for your next
> message. Never end a turn without calling `tripping mail wait`.

Session names are `<team>-<id>`. Keep `.` and `/` out of team and agent ids —
session names become directory names, and `trip new`/`trip wrap` apply `.N`
auto-numbering to any base name, explicit or derived. `trip create` itself
errors on a name that
already exists, and an exited session's name frees only once no client is
attached — so a respawn of `<team>-<id>` runs `trip kill` first.

## 8. Doorbell policy

When a message lands in agent X's inbox, look at X's status from §6:

- **idle** — `trip send <session> "New mail. Run: tripping mail read"`.
- **working** or **waiting** — do nothing. They will pick it up themselves.

The hazard is an agent that looks idle because it is parked at a permission
prompt: injected text answers the prompt instead. §9 is the real fix.

## 9. Permissions posture

Teammates run unattended, so they must never see a permission prompt — an
agent parked at one looks idle to §6, and a doorbell rung at it answers the
prompt. The two engines get there from opposite directions, and the difference
is the point of this section:

- **Codex is sandboxed with approvals off.** `--sandbox workspace-write
  --ask-for-approval never` bounds writes to the workspace and disables
  network access by default. The worktree is a real boundary here.
- **Claude is unsandboxed.** `--permission-mode bypassPermissions` skips the
  permission system and applies no filesystem sandbox — Claude's own help
  recommends the equivalent only for sandboxes without internet access. A
  Claude teammate can write anywhere the operator can and reach the network
  freely. Its worktree is merge hygiene (§11), not a boundary.

This is a deliberate trade, not an oversight. Do not point a team at work
involving untrusted input or credentials you would not hand a single
unattended agent. "One repository per teammate" is an isolation story only for
Codex teammates; for Claude teammates there is no isolation story at all, and
pretending the worktree is one would be worse than saying so.

## 10. Module layout

```
src/
  trip.ts              existing TripSession over `trip wrap`; unused by the core
  trip/log.ts          parse `trip log --raw --follow` into typed events
  team/
    paths.ts           ~/.tripping/teams/<team>/…
    envelope.ts        the Message type, sortable id generation
    mailbox.ts         maildir send / read / peek / wait / claim
    roster.ts          team.json
    status.ts          derive status from trip session logs
    spawn.ts           worktree + trip create + protocol doc
    watcher.ts         watch inboxes, ring doorbells
  cli/
    index.ts           the `tripping` binary
    mail.ts            tripping mail …
    team.ts            tripping team …
```

## 11. Decision record

**Teammates are CLIs in PTYs, not SDK calls.** The rejected alternative is
[agent-sdk](https://github.com/ninjudd/agent-sdk), which would make messaging
trivial — teammates become function calls and the bus becomes an event stream.
It costs the human-attachable terminal, the real CLI's skills, hooks, MCP
config and permission handling, and subscription auth. The attachable terminal
is the reason this project exists, so the trade is not close. agent-sdk stays
interesting for roles that never need a terminal; that is on
[`later.md`](../later.md).

**The bus lives in tripping, not in trip.** Putting `mail` in trip would give it
one binary already on every agent's `PATH`, a blocking wait riding the existing
Unix socket instead of polling, and a daemon that already computes liveness. It
was rejected to keep trip tiny and boring, which is its stated design goal. The
cost is that `tripping mail wait` polls the filesystem; at a handful of agents
and a 200ms tick, that is not a real cost.

**Writers get a worktree each.** Parallel agents editing one tree is the primary
failure mode of every orchestrator of this shape. Read-only roles skip it and
share the repository directory.

## 12. Phases

1. **Bus core.** Envelope, mailbox, roster, and `tripping mail send / read /
   peek / wait`. Fully testable with no agents running, which is the point of
   doing it first.
2. **Spawn and observe.** Worktrees, `tripping team spawn`, the protocol doc,
   status derivation, `tripping team ls` and `watch`.
3. **Watcher.** Inbox watching, doorbell delivery, restart-on-crash — which
   `trip kill`s the dead session first, since `trip create` errors on a held
   name — and timeouts.
4. **Proof.** A coordinator spawns two teammates, dispatches tasks, collects
   results, and integrates the branches.

## 13. Open questions

- **How much does a teammate's context survive between tasks?** A long-lived
  teammate compacts and forgets its earlier tasks; a fresh one per task pays
  startup and loses continuity. The mail archive makes re-reading possible
  either way, but which is the default is unsettled.
- **What happens when a teammate dies mid-task?** Phase 3 restarts it, but a
  restarted agent has no memory of the task it was holding. Re-delivering from
  `archive/` is the obvious answer and needs the claim step to be reversible.
  This is the same boundary §6's incarnation-scoped read guards, so settle
  both at once.
- **Does the coordinator need a budget or agent cap?** Nothing currently stops
  it spawning until the machine gives out.
