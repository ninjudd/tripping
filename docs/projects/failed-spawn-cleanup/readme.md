---
status: draft
priority: later
---

# A failed spawn leaves its session and roster row behind

The failure can also be a false negative. `spawnTeammate` writes the roster
row and calls `trip create` before waiting on registration, so a registration
failure throws with the session live and the row written. The teammate name
stays held and the next `trip team spawn` refuses it as already live.

**Check before you kill.** `verifyAgentRegistration` polls for 15 seconds. A
writer parks at its engine's trust dialog before it can register, and a human
takes longer than that to answer, so the throw fires and the teammate
registers immediately afterwards and gets to work. On the writer path the
timeout is *expected* to lose, not unlucky — observed in §19. Run
`trip team ls` first: a teammate that registered late reads `working` or
`waiting`, and only a genuinely absent one is flagged `gone?`. Killing on the
error alone destroys a healthy teammate mid-task along with whatever it has not
committed.

Half of the fix has landed: the error now says which case it is, so it tells
you not to kill a live one (#21). What remains is unwinding the session and the
roster row on failure, so the name is not left held. A blindly longer timeout
stays the weaker option: 15 seconds is a bet that no human is involved, and the
right answer is to notice when one is. See [`agent-orchestrator.md`](../agent-orchestrator/readme.md) §7 and §19.

This entry carries its line from `later.md` before the Projector migration.
No plan yet; write it here when the work graduates.
