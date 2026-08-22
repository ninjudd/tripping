# Now

In flight.

- [Turn tripping into an agent orchestrator](all/agent-orchestrator.md) — a
  coordinator agent in a `trip` session spawns and directs teammates, each its
  own Claude or Codex CLI in its own session, talking over a durable on-disk
  message bus. The plan's three open questions are resolved (§14 lifetime,
  §15 task custody and re-delivery, §16 population limits), every launch
  carries an autonomy tier (§9). Phases 1 to 3 are merged — the bus, spawning
  and status, the watcher — and the first run against a real `trip` is done:
  a coordinator dispatched to two Claude teammates and joined both results in
  32.5 seconds (§19). That run turned up five defects a stubbed `trip` could
  not have shown: three fixed here, and two open in trip —
  [trip#2](https://github.com/ninjudd/trip/pull/2) for the hook's agent kind
  and [trip#3](https://github.com/ninjudd/trip/pull/3) for
  `custom_tool_call`. There is no tripping-side workaround for either; the
  registration hook runs a bare `trip on`. All four phases are done, branch
  integration included: two writers on separate worktrees, both branches
  merged. One question is open and it is the plan owner's — where a writer's
  worktree should live, since both engines refuse an untrusted directory and
  `~/.trip/teams/<team>/wt/<id>` is one, so each writer needs a single human
  answer at spawn until it is settled ([`later.md`](later.md)).
