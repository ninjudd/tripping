---
status: Active
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
accident. One sender id, `tripping`, is reserved for the library's own
bookkeeping mail (§14, §15): it is minted only inside the library, is not
reachable from `tripping mail send`, and `team spawn tripping` is refused.
The address `coordinator` is likewise reserved — an alias, resolved through
`team.json` to whichever id holds the role, so the literal address every
role prompt and park mail writes to keeps working when `--coordinator` named
someone else; `team spawn coordinator` is refused too.

`tripping mail` is what every teammate uses. It is the whole surface an LLM has
to learn, so it stays at four verbs:

```
tripping mail send <to> --subject S [--kind task] [--thread T]   # body on stdin
tripping mail read                  # print unread; claim tasks, archive the rest
tripping mail peek                  # print unread, leave them
tripping mail wait [--timeout 550]  # block until mail arrives
```

Two verb semantics are load-bearing. `read` claims a `kind: task` message by
moving it to `working/` and archives every other kind (§15) — the surface
stays at four verbs, and a teammate never learns more than `read`'s output
shows. `wait` returns immediately when the inbox is already non-empty, so a
respawned teammate with queued mail unblocks itself (§14).

`tripping team` is what the coordinator uses; teammates may not spawn or kill
(§16):

```
tripping team init <name> [--max-agents N] [--max-respawns N] [--coordinator id]
tripping team spawn <id> --role "..." [--engine claude|codex] [--worktree] [--yolo]
tripping team respawn <id> [--reason "..."] [--force]
tripping team requeue <id> <msg-id>
tripping team ls                     # roster + status, live count vs cap
tripping team kill <id>
tripping team watch <id>             # tail a teammate's structured log
tripping team dispatch <file> --wait # fan out tasks, block until all results
```

`--wait` is sugar over the same primitives, for when the coordinator wants
deterministic fan-out and fan-in rather than a reactive mailbox loop.

Every command that launches an engine carries an autonomy tier (§9): the
default is auto, and `--yolo` opts into the bypass tier. `spawn` can refuse —
on the caller, the population cap, or a missing or corrupt `team.json` — and
every refusal names its recovery command (§16). `respawn` recycles an
identity (§14); `requeue` revives a parked task (§15).

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
  team.json                 roster + coordinator id + limits (§16); written tmp/ + rename
  bus.jsonl                 append-only audit: messages, task custody, population events
  tmp/                      staging for atomic writes
  agents/<id>/inbox/        <msg-id>.json — unread
  agents/<id>/working/      claimed by a live incarnation, kind task only (§15)
  agents/<id>/archive/      done
  agents/<id>/dead/         given up after the re-delivery cap (§15)
  artifacts/                large payloads, referenced by path from a message
  wt/<id>/                  git worktree, for roles that write
```

To send, write `tmp/<id>.json` and `rename` it into the recipient's `inbox/`.
A message file exists in exactly one directory at all times, immutable, moved
only by same-filesystem rename — so two readers cannot both take the same
message, and `ls` answers what is unread, in flight, done, and abandoned. A
task is claimed inbox → working, closed working → archive by its result send,
re-delivered working → inbox; every other kind archives on read. §15 owns the
lifecycle.

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
Anything large goes in `artifacts/` and is referenced, not inlined. A fresh
task's `thread` defaults to its own `id`, so the `working/` filename and its
result's `--thread` name the same string.

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
forward — discarding old events, never admitting them. During a respawn the
boundary moves before the kill: §15's respawn sequence writes the roster's
`spawned_at` first, and the scope becomes events after max(last
`agent_session_start`, `spawned_at`) — so the whole kill-to-first-event
window derives as a status of its own, `starting`, rather than as the dead
incarnation's idle.

| Last agent event | Status |
|---|---|
| `agent_turn_end`, `agent_session_end` | idle |
| none yet, boundary set by a respawn's `spawned_at` | starting |
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

Status is not liveness. Whether the session is alive comes from trip's
session list, never from these events — a killed CLI never logs
`agent_session_end` ([`trip-primitives.md`](../../trip-primitives.md)) — and
death is what triggers §15's respawn, not an idle reading.

## 7. Spawning a teammate

0. Fail-first checks, in `team/spawn.ts` so the CLI, `team dispatch`, and
   the watcher all inherit them: `team.json` present and parseable (else
   refuse, naming `tripping team init`), the caller is the coordinator or a
   human shell, the live count is under the cap, and — when the caller passes
   the auto flag — `restarts_since_human` is under `max_respawns` (§16).
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
   tailer ignores, while removing it, waiting out the tailer's poll, and
   writing it back makes it restart with the fixed config and re-parse the
   transcript from the top;
   [`trip-primitives.md`](../../trip-primitives.md) has the mechanics — and
   fail the spawn loudly when the file is missing.

The role prompt ends with the loop:

> Start every session by running `tripping mail read`. When you finish a
> task, `tripping mail send coordinator --kind result --thread <the task's
> thread>`, written so a reader with no context can act on it, then run
> `tripping mail wait` to block for your next message. Never end a turn
> without calling `tripping mail wait`.

PROTOCOL.md carries the durable half of the contract. A "Your memory"
section: `inbox/` is what you owe, `working/` is what you were holding —
check it and `git log` after any restart — `archive/` is your history,
`dead/` is what was abandoned; envelopes are plain JSON and id order is time
order, so `ls` and `cat` suffice; after any compaction or restart, re-read
them and run `git status` before resuming referenced work. Plus: commit
meaningful checkpoints as you go, and a task arriving with a restart note may
be partially done. The worktree's CLAUDE.md/AGENTS.md references PROTOCOL.md,
so the contract re-enters context after every compaction. Task messages are
written self-contained — prior work is referenced by thread id, never by
assumed recall — which makes every result a self-summary for its sender's own
successor (§14).

Session names are `<team>-<id>`. Keep `.` and `/` out of team and agent ids —
session names become directory names, and `trip new`/`trip wrap` apply `.N`
auto-numbering to any base name, explicit or derived. `trip create` itself
errors on a name that already exists, and an exited session's name frees only
once no client is attached — so a respawn of `<team>-<id>` runs `trip kill`
first.

## 8. Doorbell policy

When a message lands in agent X's inbox, look at X's status from §6:

- **idle** — `trip send <session> "New mail. Run: tripping mail read"`.
- **working** or **waiting** — do nothing. They will pick it up themselves.
- **starting** (§6) — do nothing. A respawned teammate's first action is
  `tripping mail read`, so the restart path needs no doorbell at all.

Every injection into a live session passes one guard first: `trip screen`,
checked for the engine's permission-prompt signature. §9's default tier can
park a teammate at a confirmation prompt, a prompt produces no event, and
injected text would answer it — so a parked teammate is never rung. Instead
it is flagged by `tripping team ls` (an annotation on top of §6's status,
from the same check, not a new derived state) and the coordinator gets a
`kind: note` from `tripping` naming the session, so a human can
`trip attach` and answer. This is the plan's one deliberate screen-scrape:
never for status, which stays log-derived (§6), only as the safety interlock
before typing into a terminal sight unseen.

One nudge exists outside delivery: a teammate idle with a non-empty
`working/` gets a reminder doorbell naming the task it still holds — never a
reclaim (§15). The nudge passes the same guard.

## 9. Permissions posture

Teammates run unattended, so a human permission prompt is this posture's
enemy: an agent parked at one emits no events, looks idle to §6, and a
doorbell rung at it would answer the prompt. Every engine launch carries one
of two autonomy tiers — there is no interactive tier — chosen at spawn
(`--yolo`, §4):

- **auto — the default.** Claude launches with `--permission-mode auto`: a
  classifier reviews each action and allows it, denies it, or asks. A denial
  returns as a failed tool call with work-around guidance and the teammate
  keeps going; an ask, in an unattended PTY, is a parked confirmation
  prompt — the tier's one hazard, made survivable by §8's guard. Codex
  launches with `--approve-for-me`: approval requests routed through
  automatic review, inside the `workspace-write` sandbox — writes bounded to
  the workspace, network off by default, and no path to a human prompt.
- **yolo — explicit opt-in.** Claude `--permission-mode bypassPermissions`,
  Codex `--dangerously-bypass-approvals-and-sandbox`. No review and no
  sandbox, on either engine.

auto is chosen over `dontAsk` — the mode that turns every would-be ask into
a deny and so can never park — because the classifier is strictly more
permissive about useful work, and a parked prompt caught by the guard is
survivable where a too-eager deny is invisible friction. The cost is named
here and paid in §8: a prompt produces no event, so no log-derived status
can see one, and the only safe detector is the screen itself.

Even on the auto tier the engines differ, and the difference is worth
stating: Codex's sandbox is a real write boundary; Claude's classifier gates
actions but applies no filesystem sandbox, so a Claude teammate can still
write anywhere the operator can, and its worktree is merge hygiene (§11), not
a boundary. This is a deliberate trade, not an oversight. Do not point a team
at work involving untrusted input or credentials you would not hand a single
unattended agent — and treat `--yolo` as removing what little the auto tier
guards.

## 10. Module layout

```
src/
  trip.ts              existing TripSession over `trip wrap`; unused by the core
  trip/log.ts          parse `trip log --raw --follow` into typed events
  team/
    paths.ts           ~/.tripping/teams/<team>/…
    envelope.ts        the Message type, sortable id generation
    mailbox.ts         send / read / peek / wait; claim, close, requeue
    roster.ts          team.json
    status.ts          derive status from trip session logs
    spawn.ts           checks (§16) + worktree + create + respawn (§15)
    watcher.ts         inbox watch, doorbells, death detection, sweep
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
share the repository directory. The coordinator integrates and squashes the
teammate branches, which is also what absorbs §15's checkpoint commits.

**Cost budgets are refused, not deferred.** trip's normalized events carry no
usage fields, subscription auth has no per-session metering, and neither
engine can be preempted from outside mid-turn — so any budget tripping
claimed to enforce would be fiction, and a recorded-but-unenforced number is
worse than none. The enforceable proxies are concurrent teammates and
consecutive crash respawns, and §16 enforces exactly those.
Transcript-parsing usage recorders are on [`later.md`](../later.md) as
observability, never enforcement.

## 12. Phases

1. **Bus core.** Envelope, mailbox, roster, and `tripping mail send / read /
   peek / wait`. Fully testable with no agents running, which is the point of
   doing it first. Pins the two §4 semantics: `read` claims tasks into
   `working/`, and `wait` returns immediately on a non-empty inbox.
2. **Spawn and observe.** Worktrees, `tripping team spawn` with §16's checks
   in `spawn.ts`, the protocol doc, status derivation, `tripping team ls` and
   `watch`.
3. **Watcher.** Inbox watching, doorbell delivery, death detection, and the
   respawn sequence and reconcile sweep §15 spells out — the sweep also runs
   inside `dispatch --wait`'s poll loop, so fan-in fails fast on a dead
   teammate instead of hanging — plus §16's crash-loop breaker. Timeouts only
   escalate: a live-but-wedged teammate — including one that finished but
   never sent its result — is reported to the coordinator and the human,
   never auto-reclaimed from a possibly-live incarnation. (A *dead* teammate
   that never sent its result is §15's ordinary re-delivery case.)
4. **Proof.** A coordinator spawns two teammates, dispatches tasks, collects
   results, and integrates the branches.

## 13. Open questions

All three questions this section carried are resolved; each answer is a
section of its own, carrying its decision record. The section number stays so
existing citations keep meaning, and new open questions land here.

- **Teammate lifetime** — resolved in §14: long-lived by default, memory of
  record on disk, one `respawn` verb for deviation.
- **Death mid-task** — resolved in §15, and the answer diverged from this
  bullet's original strawman: re-delivery is a fourth message state,
  `working/`, not a reversal of the archive claim.
- **Budget or cap** — resolved in §16: a concurrent cap and a crash-loop
  breaker are enforced; cost budgets are refused as unenforceable (§11).

## 14. Teammate lifetime

Teammates are long-lived: one PTY session per roster id for the life of the
team, parked in `tripping mail wait` between tasks. Compaction is accepted
rather than fought — the memory of record is on disk (the mail directories,
`bus.jsonl`, the worktree and its branch), and the context window is a cache
of it. §7's PROTOCOL.md guidance is that model made explicit to the teammate.

Fresh-per-task was rejected because it makes §3's blocking wait and §8's
doorbell dead code, pays engine warm-up plus one pass through §7 step 4's
agent.json repair per task, and destroys the attach story that is this
project's reason to exist: the teammate you took the wheel of yesterday must
still exist today. Stateless per-task roles remain available as coordinator
policy — respawn before every dispatch — not as a CLI mode.

Deviation is one verb: `tripping team respawn <id> [--reason "..."]
[--force]`, which kills and recreates the same identity — id, session name,
mailbox, worktree, branch — and is the same sequence the Phase 3 watcher runs
on a dead session (§15 owns the sequence). The coordinator respawns
deliberately when a teammate is reassigned to unrelated work, when it
observes degradation, or when a teammate self-reports a bad compaction
(`mail send coordinator --kind control`). The boundary for a deliberate
respawn is the result mail for the last dispatched task having arrived,
matched by thread — not derived status, which cannot confirm idleness for a
Codex teammate (§6). Incarnations share the mailbox, so mail landing during
the respawn window simply waits in `inbox/`. When no inherited context is
wanted at all, kill and spawn a new id instead.

Every respawn writes a restart notice — an ordinary `kind: control` mail from
`tripping` carrying `--reason` — into the fresh incarnation's inbox, so its
first `mail read` explains its own amnesia, points at the archive, and lands
in `bus.jsonl` as an audit of every restart. Rejected: a roster state
machine, `--task` staging, and `--max-tasks` recycle caps — each moves policy
the coordinator can already express into CLI machinery, against the plan's
smarts-in-the-coordinator, safe-primitives-in-the-CLI grain.

## 15. Task custody and re-delivery

Re-delivery is not a reversal of the archive claim; it is a fourth message
state. §5 has the layout: a task is claimed inbox → working by `mail read`,
closed working → archive by `mail send --kind result --thread T` after the
result is delivered, re-delivered working → inbox by a respawn, and parked in
`dead/` past the re-delivery cap. Deliver-then-close ordering means a crash
between the two leaves a done-looking task in `working/` with its result
durable — the sweep below dedups it; the reverse order could close a task
whose result was never sent. Non-task mail archives on read, deliberately
at-most-once: an answer read by a dead incarnation is gone, and the fresh one
re-asks. If `--thread` is missing and exactly one task is in `working/`, the
send closes it with a printed warning; if several are, it closes nothing and
prints the listing so the agent self-corrects.

Death detection uses trip's session list — Exited or missing — never a
timeout and never the log tail, because a killed CLI never logs
`agent_session_end` ([`trip-primitives.md`](../../trip-primitives.md)). A
live-but-wedged teammate is never reclaimed automatically: reclaiming from a
possibly-live incarnation is the one unrecoverable mistake, so timeouts only
escalate (§12).

The respawn sequence — one implementation in `spawn.ts`, invoked by the
watcher on a dead session and by `tripping team respawn` deliberately. Every
step is an idempotent rename or a tolerated error, so a crash at any point is
recovered by rerunning:

1. Guard: a session Exited or missing passes unconditionally. A live session
   deriving `working` is refused without `--force`, and the refusal restates
   §6's Codex caveat so the operator is not misled at 2am.
2. Write `spawned_at` (and increment `spawns`) into the roster row via tmp/ +
   rename, before the kill — from here to the first new event §6 derives
   `starting`, and §8 stays quiet, statelessly.
3. `trip kill <team>-<id>`, tolerating "session not found".
4. Checkpoint a dirty worktree: abort any in-progress rebase or merge, then
   commit everything on the teammate's own branch ("tripping: checkpoint
   <id> before respawn"). Committed work always survives; the coordinator
   squashes at integration (§11).
5. Reclaim `working/`, judging each task from `bus.jsonl`: result already
   recorded → archive (the crash ate only bookkeeping); past the re-delivery
   cap (default 2, counted from its redeliver lines) → `dead/`, plus a park
   mail to the coordinator on the task's thread — `kind: result`, from
   `tripping` — so a `dispatch --wait` join returns failure instead of
   hanging; otherwise → back to `inbox/`, with a companion `kind: note`
   naming the delivery attempt and the checkpoint SHA. Sortable ids print
   the re-delivered task before its explanation.
6. Write §14's restart notice into the inbox — after the kill, so no live
   wait can eat it.
7. `trip create` exactly as §7 step 3, the role prompt prefixed with a resume
   preamble: fresh incarnation of <id>; read PROTOCOL.md, run `tripping mail
   read`, check `git status`, then `tripping mail wait`. Retry once on a
   connection failure: killing the daemon's last session makes the daemon
   exit, and a create in that window catches it mid-shutdown, when the old
   process still holds the lock the new one needs.
8. Re-run §7 step 4's agent.json verification.

The reconcile sweep — watcher startup, every tick, and inside
`dispatch --wait`'s poll loop, so a coordinator with no watcher cannot wait
forever on a dead teammate. For each `working/` file: result on `bus.jsonl` →
archive it; session dead → run the sequence above; live and idle → §8's nudge
doorbell, never a reclaim. Stray `tmp/` files older than an hour are removed.
Everything derives from the directories, `bus.jsonl`, and trip's session
list — nothing from process memory — so a watcher crash mid-sequence or two
concurrent watchers converge on the same state.

`bus.jsonl` grows from message audit to custody audit: one short line per
claim, close, redeliver (with attempt number), dead-letter, and checkpoint,
so `grep <task-id> bus.jsonl` prints a task's whole lifecycle and the
re-delivery count needs no state file. `tripping team requeue <id> <msg-id>`
renames working|dead → inbox with the same audit line, reviving a parked
task; `team ls` shows `working/` and `dead/` counts per teammate.

This is at-least-once delivery, knowingly: a teammate that died after
committing work but before its result send is handed the task again, bounded
by the companion note pointing at `git log`. Rejected alternatives: reversing
the archive claim (conflates read with done, and in-flight state stops being
one `ls`); a fifth ack verb (grows the LLM surface, and a forgotten ack is a
false re-delivery); closing `working/` from the result's reader (one agent
mutating another's mailbox); death by log tail or timeout (misses SIGKILL,
double-runs slow agents); hard-resetting the worktree (destroys work
invisibly); archiving poisoned tasks (conflates done with given up); a lease
or heartbeat sidecar (a second source of truth that goes stale exactly when
things crash); visibility timeouts or in-place status edits (hidden timers,
`ls`-invisible state); re-sending a fresh copy of the task (breaks thread
correlation and strands the original).

## 16. Population limits

v1 enforces exactly two limits, both stored in `team.json` and checked at the
one chokepoint every spawn passes through (§7 step 0):

- **A concurrent-teammate cap.** `limits.max_agents`, default 4, coordinator
  excluded; live means a roster entry without `killed_at`. At the cap, spawn
  refuses and the error names the recovery — kill a teammate, or raise the
  number by editing `team.json`. There is deliberately no per-spawn override
  flag: the spawner must not be able to raise its own limit.
- **A crash-loop breaker.** `limits.max_respawns`, default 3. The watcher
  increments the roster's `restarts_since_human` on each automatic respawn;
  at the limit it leaves the session down, appends a refusal line to
  `bus.jsonl`, and mails the coordinator a note naming
  `trip log <team>-<id>` as the autopsy — the log outlives the session (§6).
  The counter resets on a result whose envelope `from` is the agent's own id
  (mail from `tripping` never resets anything), or on a deliberate
  `team spawn`/`team respawn`. Auto is an explicit flag `spawn.ts` takes from
  its caller — the watcher passes it; the CLI does not — never a guess from
  the environment, and `bus.jsonl`'s population lines record which.

Only the coordinator or a human shell may spawn or kill: when
`TRIPPING_AGENT` names a teammate, both verbs refuse, and the message names
the escalation (`tripping mail send coordinator --kind question`). Teammates
spawning sub-teams is rejected for v1 — every downstream mechanism, from §3's
loop to §8's doorbell to §11's integration to the flat `agents/` tree,
assumes a one-level team, and the escalation path costs one message. Sub-teams
are on [`later.md`](../later.md).

`tripping team init` writes the defaults into `team.json` — coordinator id,
`limits {max_agents, max_respawns}` — so the file never lies about what
applies; a hand-built file missing `limits` gets the defaults written back
with a note. Spawn fails closed on a missing or unparseable `team.json`.
`tripping team kill <id>` runs `trip kill` first, then stamps `killed_at` via
tmp/ + rename; rerunning is the crash recovery, and `team ls` flags a
roster/daemon mismatch. A crashed teammate pins its slot until killed —
deliberate, so the cap forces cleanup instead of silently freeing slots.
Spawns, kills, and refusals all append control lines to `bus.jsonl`, so
population history replays next to message history. `team ls` shows age,
spawn counts, and message counts as activity proxies, labeled as such — never
as spend (§11).

Two honest limits. The cap and the caller gate stop runaway loops and
accidents, not a yolo-tier teammate that unsets `TRIPPING_AGENT`, calls
`trip create` raw, or edits `team.json` — §9 is why that sentence has to
exist, and `bus.jsonl` makes any population change explainable after the
fact. And cap enforcement is check-then-write, so a human and the coordinator
spawning simultaneously can overshoot by one — bounded, visible in `team ls`,
accepted at this scale.
