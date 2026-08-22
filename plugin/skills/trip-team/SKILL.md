---
name: trip-team
description: The message protocol for an agent working on a trip team — reading your inbox, sending results to your coordinator, blocking for the next message, contacting teammates, and recovering the work you were holding after a restart. Use whenever TRIP_TEAM is set in the environment, and whenever you are told you are a teammate or a coordinator on a team.
---

# Working on a trip team

You are one agent on a team that talks over a durable on-disk message bus.
Your identity is `TRIP_AGENT` on team `TRIP_TEAM`, both in your environment.
Run `echo "$TRIP_AGENT on $TRIP_TEAM"` if you are unsure who you are.

The bus is files. Your context window is a cache of it, and it is the cache
that gets lost — after a compaction or a restart, the files are still right.

## The loop

1. `trip message read` — claim what is waiting. Do this first, every session.
2. Do the work.
3. Send the result, body on stdin, `--subject` required:

   ```
   echo "what you did, self-contained" | trip message send coordinator \
     --kind result --thread <the task's thread> --subject "..."
   ```

4. `trip message wait` — block until the next message arrives.

**Never end a turn without calling `trip message wait`.** Ending a turn without
it makes you idle with no way to reach you except a doorbell typed into your
terminal. Blocking in `wait` means your next message arrives as a tool result
and you simply keep going.

Write every result so someone with no context can act on it. Your coordinator
did not watch you work and cannot see your screen.

## Message kinds

| Kind | Use it for |
|---|---|
| `task` | work you are handing to someone |
| `result` | the outcome of a task — always carries its `--thread` |
| `question` | you are blocked and need an answer |
| `note` | context that needs no reply |

A `result` must carry the `--thread` of the task it answers. That thread is
how a waiting coordinator matches your answer to its question; without it, a
`dispatch --wait` join cannot tell that your task is done.

**Copy the thread exactly as `trip message read` printed it.** It is an
opaque id like `01M0M42N7ZKJD42BGYVZY3DP7Y`, not a description. A readable
slug invented from the subject — `fix-typo-app-py` — correlates with
nothing: the task stays open, and a coordinator waiting on the real thread
waits for the whole timeout for a result you already sent. Sending one is
refused, and the refusal tells you the thread to use.

## Your mailbox is your memory

Under `~/.trip/teams/$TRIP_TEAM/agents/$TRIP_AGENT/`:

- `inbox/` — what you owe
- `working/` — what you claimed and have not answered yet
- `archive/` — what you have finished
- `dead/` — what was abandoned after too many failed attempts

Envelopes are plain JSON and ids sort in time order, so `ls` and `cat` are
enough to read any of it.

## After a restart

You may be a fresh incarnation of an agent that died mid-task. When that
happens you will find a task in your inbox with a companion note explaining
the restart. Before redoing anything:

1. `trip message read` — the note names the checkpoint commit, if there was one.
2. `git log` and `git status` — your predecessor's work was committed for you.
   The task may be most of the way done.
3. `ls ~/.trip/teams/$TRIP_TEAM/agents/$TRIP_AGENT/working/` — anything still
   there is a task you are still holding.

Commit meaningful checkpoints as you go. It is what makes your work survive.

## Your team

`trip team ls` lists everyone: id, role, engine, status. Every id is
addressable, teammates included — you do not have to route through your
manager to ask a peer something.

Your coordinator is always addressable as `coordinator`, whatever its id.
Blockers and questions go there:

```
echo "I need X before I can finish Y" | trip message send coordinator \
  --kind question --thread <the task's thread> --subject "blocked on X"
```

## If you are the coordinator

You direct the team rather than doing the work:

```
trip team spawn <id> --role "..." [--engine claude|codex] [--worktree]
trip team ls
echo "..." | trip message send <id> --kind task --subject "..."
```

Every task must be self-contained. Reference earlier work by thread id — a
teammate has no memory of a conversation it was not in, and a restarted one
has no memory of a conversation it *was* in.

Collect with `trip message read`, and block between rounds with
`trip message wait` like everyone else.
