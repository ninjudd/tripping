# Projects

`docs/` describes how the system works today. `docs/projects/` is the work
itself.

Three lists say what is happening and when:

- [`now.md`](now.md) — in flight.
- [`next.md`](next.md) — queued, starting soon.
- [`later.md`](later.md) — wanted, not scheduled.

Every plan lives in [`all/`](all/) and nothing ever moves out of it. The lists
point into `all/`; a project changing phase is an edit to the lists, not a file
move. A project is one file, `all/<name>.md`, until it genuinely outgrows one —
several phases in flight, a design wanting its own space, a decision log worth
keeping apart from the plan. Then it becomes a folder, `all/<name>/`, whose
entry point is `README.md`. Promotion is one `git mv` inside `all/`, so none of
this is decided up front, and it is the one move the rule above allows.

## Frontmatter

Every plan carries YAML frontmatter with `status:` — on the file when it is a
file, on `README.md` when it is a folder, where it is the status of the whole
project. The keyword is one of:

| Keyword | Meaning |
|---|---|
| `Draft` | Written, implementation not started |
| `Active` | In progress |
| `Blocked` | Waiting on a dependency or decision |
| `Stalled` | Lost momentum, not formally dropped |
| `Shipped` | Delivered |
| `Superseded` | Replaced by another plan |
| `Abandoned` | Dropped |
| `Reference` | A standing document with no build lifecycle |

`Active`, `Blocked`, and `Shipped` claim the plan is executable; the other five
claim nothing of the sort. Open questions in a plan carrying one of the five do
not block its pull requests. The pull request that flips a plan into one of the
three is the one making the readiness claim, and it answers for every question
still open at that moment.

The keyword is the state of record; the *why* stays prose in the body. A plan
whose status frontmatter is stale is worse than one with no status at all.

Every plan also carries `owner:` — the single person to ask about it. It names
who answers questions on the plan and who decides whether it is still worth
doing, which is not necessarily who writes the code. Write it as
`first_name.last_name`.

## Citing a plan

Plans are cited by section — `agent-orchestrator.md §5` — including from code
comments and from other plans. Renumbering a section silently breaks those
references, so **add new sections at the end** rather than inserting them.

## Keeping it current

The lists and the status frontmatter ride the pull request that changes what
they say. The pull request completing a plan sets `status: Shipped` and edits
`now.md` in the same diff. Do not plan a separate close-out pull request.

## New findings become projects

A new issue found in existing code becomes its own project. Do not fold the fix
into the pass that found it — it puts a second argument in front of a reviewer
already holding one, and it lands a behavior change that nothing in the pull
request asked for.

A defect the change itself introduced is the opposite case: it belongs in the
same pass, because the pull request is what put it there.

## Relationship to `docs/`

Method and system documents stay in `docs/` and are cited from plans, not
absorbed into them. They outlive the projects that produced them:

- [`trip-primitives.md`](../trip-primitives.md) — the trip session, event, and
  environment guarantees everything here builds on.
