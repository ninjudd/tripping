---
status: draft
priority: later
---

# Writer worktrees land where neither engine trusts them

[`agent-orchestrator.md`](../agent-orchestrator/readme.md) §7 puts them at `~/.trip/teams/<team>/wt/<id>`, and both Claude and
Codex gate an untrusted directory behind a prompt the teammate cannot answer —
so every writer parks at startup, before it registers, and stays parked until a
human attaches. Codex's dialog matches none of §8's text signatures, so the
selector glyph is the only thing that detects it at all.

The fix looks cheap: both engines inherit trust from an enclosing trusted
repository, and a **git worktree inside that repository** passes for both —
verified against real sessions of each, including the worktree case, where the
`.git` file might have made it a separate project and does not. Codex does
treat a nested `git init` repository as its own project and prompts for it, so
the distinction that matters is worktree-inside-the-repo versus
independent-checkout-elsewhere. Siting them at `<repo>/.tripping/wt/<id>` would
sidestep the dialog entirely, at the cost of worktrees living in the operator's
checkout, which §15's pathspec work was careful to avoid. tripping must not
grant trust on the operator's behalf by editing their config — attempting it
here was correctly blocked. See [`agent-orchestrator.md`](../agent-orchestrator/readme.md) §7.

This is the one open question
[`agent-orchestrator`](../agent-orchestrator/readme.md) still carries, and it is
the plan owner's to answer.

This entry carries its line from `later.md` before the Projector migration.
No plan yet; write it here when the work graduates.
