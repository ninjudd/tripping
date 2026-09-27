---
status: draft
priority: later
---

# `trip ls --json`

A machine-readable session list would let tripping check liveness against the
daemon without parsing human-formatted output; until then `spawn.ts` shells out
to `trip ls -a` and tolerates format drift.

This entry carries its line from `later.md` before the Projector migration.
No plan yet; write it here when the work graduates.
