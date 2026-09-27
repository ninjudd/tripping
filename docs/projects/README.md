# Project plans

`docs/` describes how the system works today. `docs/projects/` is the work
itself.

This directory follows the [Projector](https://github.com/ninjudd/projector)
convention. Store each project in a permanent directory under `docs/projects/`.
Use a lowercase `readme.md` entry point with YAML frontmatter carrying two
fields: `status: draft|ready|in-progress|completed` records the lifecycle, and
`priority: now|next|later` records when the work should happen. Priority is
required unless the status is `completed`. Nest a project directory inside
another project when the work is a subproject. Keep supplemental files beside
the entry point that owns them.

Status and priority changes edit frontmatter. Do not create shared queue
files, status or priority directories, or symlinks, and do not move a project
when its status or priority changes. Number plan sections and never renumber
them after another document or code comment cites them.

Run `project list` to browse projects and `project check` to validate the
tree. Both commands come from the Projector CLI:

```sh
pipx install git+https://github.com/ninjudd/projector.git
```

## Conventions this repository adds

Keep the `**Status:**` prose line under a plan's title. The frontmatter is the
state of record; the line says why, and what is left.

Cite a plan by section using the project name and a `.md` suffix, for example
`agent-orchestrator.md §5`, which names
`docs/projects/agent-orchestrator/readme.md`. Code comments and other plans
carry these citations, so renumbering a section silently breaks references
that no compiler catches. Add new sections at the end rather than inserting
them.

A project with no plan yet is still a project. Give it a directory and a short
`readme.md` that records the idea and why it matters, rather than a line in a
shared list.

This repository has one person to ask about any plan, so plans carry no
`owner:` field. Add one, as a GitHub login, if that changes.

## New findings become projects

A new issue found in existing code becomes its own project. Do not fold the fix
into the pass that found it — it puts a second argument in front of a reviewer
already holding one, and it lands a behavior change that nothing in the pull
request asked for.

A defect the change itself introduced is the opposite case: it belongs in the
same pass, because the pull request is what put it there.

## What does not go here

Method and system documents stay in `docs/` and are cited from plans, not
absorbed into them. They outlive the projects that produced them:

- [`trip-primitives.md`](../trip-primitives.md) — the trip session, event, and
  environment guarantees everything here builds on.
