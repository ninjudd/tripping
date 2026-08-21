# Now

In flight.

- [Turn tripping into an agent orchestrator](all/agent-orchestrator.md) — a
  coordinator agent in a `trip` session spawns and directs teammates, each its
  own Claude or Codex CLI in its own session, talking over a durable on-disk
  message bus. The plan's three open questions are resolved (§14 lifetime,
  §15 task custody and re-delivery, §16 population limits), every launch
  carries an autonomy tier (§9), and implementation starts with Phase 1 — the
  bus and the `tripping mail` verbs, testable with no agents running.
