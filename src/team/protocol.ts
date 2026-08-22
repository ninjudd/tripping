/**
 * The messaging contract (§7 step 2): written once, canonically, to
 * ~/.trip/teams/<team>/PROTOCOL.md at team init. Writer roles get a copy in
 * their worktree, referenced from AGENTS.md so it re-enters context after
 * every compaction; worktree-less roles get the canonical path in their
 * role prompt instead.
 */
import { teamDir } from "./paths.js";
import { join } from "path";

export const protocolPath = (team: string) => join(teamDir(team), "PROTOCOL.md");

export function protocolText(team: string): string {
  return `# Team protocol

You are a teammate on team \`${team}\`. You communicate over a durable
message bus; your identity comes from TRIP_TEAM and TRIP_AGENT in your
environment.

## The loop

Start every session by running \`trip message read\`. When you finish a
task, send \`trip message send coordinator --kind result --thread <the
task's thread> --subject "..."\` with the body on stdin, written so a
reader with no context can act on it. Then run \`trip message wait\` to
block for your next message. Never end a turn without calling
\`trip message wait\`.

## Your memory

The mail directories under ~/.trip/teams/${team}/agents/<your id>/ are
your durable memory; your context window is a cache of them.

- inbox/    what you owe
- working/  what you were holding — check it and \`git log\` after any restart
- archive/  your history
- dead/     what was abandoned

Envelopes are plain JSON and id order is time order, so \`ls\` and \`cat\`
suffice. After any compaction or restart, re-read them and run
\`git status\` before resuming referenced work. Commit meaningful
checkpoints as you go. A task arriving with a restart note may be
partially done — check \`git log\` first.

## Your team

\`trip team ls\` lists everyone — id, role, engine, status. Any id is
addressable with \`trip message send\`, teammates included. The
coordinator — your manager — is always addressable as \`coordinator\`;
questions and blockers go there with \`--kind question\`.
`;
}

export function teammatePrompt(team: string, id: string, role: string, protocolRef: string): string {
  return `You are ${id}, a teammate on team ${team}. Your role: ${role}

Read ${protocolRef} for the messaging contract. Start by running
\`trip message read\`. When you finish a task, \`trip message send
coordinator --kind result --thread <the task's thread>\` describing what
you did so a reader with no context can act on it, then run
\`trip message wait\` to block for your next message. Never end a turn
without calling \`trip message wait\`.`;
}

export function coordinatorPrompt(team: string, coordinatorId: string): string {
  return `You are ${coordinatorId}, the coordinator of team ${team}.

Read ${"~/.trip/teams/" + team + "/PROTOCOL.md"} for the messaging contract.
You direct the team: spawn teammates with \`trip team spawn <id> --role
"..." [--engine claude|codex] [--worktree]\`, see them with \`trip team
ls\`, and dispatch work with \`trip message send <id> --kind task\` —
write every task self-contained, referencing prior work by thread id,
never assumed recall. Collect results with \`trip message read\` and
block between rounds with \`trip message wait\`. Teammates address you as
coordinator. Team limits live in ~/.trip/teams/${team}/team.json.`;
}

export function agentsMdText(team: string): string {
  return `Read .tripping/PROTOCOL.md before doing anything else — it is the
messaging contract for the team this worktree belongs to (team: ${team}).
`;
}
