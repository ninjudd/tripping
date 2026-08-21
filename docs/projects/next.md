# Next

Queued, starting soon.

- [Turn tripping into an agent orchestrator](all/agent-orchestrator.md) — a
  coordinator agent in a `trip` session spawns and directs teammates, each its
  own Claude or Codex CLI in its own session, talking over a durable on-disk
  message bus. The inbox carries the content and a `trip send` doorbell wakes
  whoever has gone idle; `agent_turn_end` says who that is. Phase 1 is the bus
  and the `tripping mail` verbs, which are testable with no agents running.
  Nothing in trip has to change for any of it.
