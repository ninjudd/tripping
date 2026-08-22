/**
 * The §15 respawn sequence — one implementation, invoked by the watcher on
 * a dead session and by `trip team respawn` deliberately. Every step is an
 * idempotent rename or a tolerated error, so a crash at any point is
 * recovered by rerunning.
 */
import { execFileSync } from "child_process";
import { join } from "path";
import { renameSync, mkdirSync } from "fs";
import { readTeam, writeTeam } from "./roster.js";
import {
  bus,
  readBus,
  send,
  workingEntries,
  RESERVED_SENDER,
} from "./mailbox.js";
import {
  callerGate,
  engineCommand,
  tripExec,
  tripKillTolerant,
  sessionAlive,
  verifyAgentRegistration,
} from "./spawn.js";
import { deriveStatus, sessionName } from "./status.js";
import { archiveDir, deadDir, inboxDir, workingDir } from "./paths.js";
import {
  coordinatorPrompt,
  protocolPath,
  teammatePrompt,
} from "./protocol.js";

/** §15: a task is handed back at most this many times before dead/. */
export const REDELIVERY_CAP = 2;

export interface RespawnOptions {
  reason?: string;
  force?: boolean;
  /** Set by the watcher; drives the §16 breaker bookkeeping. */
  auto?: boolean;
  registrationTimeoutMs?: number;
}

/** Step 4: checkpoint a dirty worktree so committed work always survives.
 *  Excludes the instruction files tripping itself created (§15 step 4). */
export function checkpointWorktree(
  worktree: string,
  id: string,
  attempt: number
): string | null {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (git(["status", "--porcelain"]).trim() === "") return null;
  for (const abort of [["rebase", "--abort"], ["merge", "--abort"]]) {
    try {
      git(abort);
    } catch {
      /* nothing in progress */
    }
  }
  // tripping always owns .tripping/. The instruction files are its own only
  // when it created them, and §7 step 2 creates them only when absent — so a
  // tracked one is the repo's, and a teammate's edits to it belong in the
  // checkpoint like any other work.
  const excludes = [":(exclude).tripping"];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      git(["ls-files", "--error-unmatch", "--", f]);
    } catch {
      excludes.push(`:(exclude)${f}`);
    }
  }
  git(["add", "-A", "--", ...excludes]);
  try {
    git([
      "commit",
      "--no-verify",
      "-m",
      `tripping: checkpoint ${id} before respawn (attempt ${attempt})`,
    ]);
  } catch {
    return null; // nothing staged (only excluded files were dirty)
  }
  return git(["rev-parse", "HEAD"]).trim();
}

/** Step 5: judge each held task from bus.jsonl — dedup, re-deliver, or
 *  dead-letter with the park mail that fails a dispatch join fast. */
export function reclaimWorking(
  team: string,
  id: string,
  coordinator: string,
  checkpointSha: string | null,
  /** terminal: the teammate is not coming back (the §16 breaker gave up on
   *  it), so re-delivery is pointless and every held task dead-letters. */
  opts: { terminal?: boolean } = {}
): void {
  const lines = readBus(team);
  for (const { file, message } of workingEntries(team, id)) {
    const taskId = file.replace(/\.json$/, "");
    const thread = message.thread;
    const resultRecorded = lines.some(
      (l) =>
        l.event === "message" &&
        l.kind === "result" &&
        l.from === id &&
        l.thread === thread
    );
    if (resultRecorded) {
      // The crash ate only the bookkeeping; the result is already durable.
      renameSync(
        join(workingDir(team, id), file),
        join(archiveDir(team, id), file)
      );
      bus(team, { event: "close", agent: id, id: taskId, thread });
      continue;
    }
    const attempts = lines.filter(
      (l) => l.event === "redeliver" && l.id === taskId
    ).length;
    if (opts.terminal || attempts >= REDELIVERY_CAP) {
      mkdirSync(deadDir(team, id), { recursive: true });
      renameSync(
        join(workingDir(team, id), file),
        join(deadDir(team, id), file)
      );
      bus(team, { event: "dead_letter", agent: id, id: taskId, thread });
      // kind:result on the task's thread, so a dispatch --wait join returns
      // failure instead of hanging; the coordinator LLM decides what next.
      send(team, {
        from: RESERVED_SENDER,
        to: coordinator,
        kind: "result",
        thread,
        subject: opts.terminal
          ? `task failed: ${id} is down for good — crash-loop breaker tripped`
          : `task failed: ${id} died ${attempts + 1} times holding it`,
        body:
          `Task ${taskId} is dead-lettered in agents/${id}/dead/. ` +
          `Revive it with: trip team requeue ${id} ${taskId} — or re-dispatch ` +
          `it elsewhere, split it, or ask the human.`,
      });
      continue;
    }
    renameSync(
      join(workingDir(team, id), file),
      join(inboxDir(team, id), file)
    );
    bus(team, {
      event: "redeliver",
      agent: id,
      id: taskId,
      thread,
      attempt: attempts + 1,
    });
    // Companion note: sortable ids put the re-delivered task first, its
    // explanation second, in the same read.
    send(team, {
      from: RESERVED_SENDER,
      to: id,
      kind: "note",
      thread,
      subject: `task re-delivered (attempt ${attempts + 1})`,
      body:
        `Your previous incarnation died holding this task. ` +
        (checkpointSha
          ? `The worktree was checkpointed at ${checkpointSha}. `
          : `The worktree was clean. `) +
        `Run git log on your branch before redoing work.`,
    });
  }
}

export interface RespawnResult {
  id: string;
  session: string;
  checkpoint: string | null;
}

export async function respawnTeammate(
  team: string,
  id: string,
  opts: RespawnOptions = {}
): Promise<RespawnResult> {
  const roster = readTeam(team);
  if (roster === null)
    throw new Error(`no team.json for '${team}' — run: trip team init ${team}`);
  callerGate(roster);
  const row = roster.agents[id];
  if (!row)
    throw new Error(`'${id}' is not on the roster — spawn it instead`);
  const session = sessionName(team, id);

  // 1. Guard: a dead session passes unconditionally; a live one deriving
  // working is refused without --force. The refusal restates §6's caveat
  // so a 2am operator is not misled.
  const alive = sessionAlive(session);
  if (alive && !opts.force) {
    const status = deriveStatus(team, id);
    if (status === "working") {
      throw new Error(
        `'${id}' derives working — refusing without --force. Caveat: a ` +
          `Codex teammate blocked in trip message wait also reads as ` +
          `working (§6), so check trip screen ${session} before forcing.`
      );
    }
  }
  if (opts.auto) {
    const restarts = row.restarts_since_human ?? 0;
    if (restarts >= roster.limits.max_respawns) {
      bus(team, {
        event: "spawn_refused",
        agent: id,
        by: "watcher",
        reason: `breaker: ${restarts} restarts since a human touch`,
      });
      throw new Error(
        `'${id}' crashed ${restarts}x; leaving it down (limits.max_respawns). ` +
          `Autopsy: trip log ${session}. A deliberate trip team respawn ` +
          `resets the breaker.`
      );
    }
  }

  // 2. spawned_at first: from here to the first new event, §6 derives
  // starting and the doorbell stays quiet — statelessly.
  row.spawned_at = new Date().toISOString();
  row.spawns = (row.spawns ?? 0) + 1;
  row.restarts_since_human = opts.auto
    ? (row.restarts_since_human ?? 0) + 1
    : 0;
  delete row.killed_at;
  delete row.park_noted;
  delete row.breaker_noted;
  writeTeam(team, roster);
  bus(team, {
    event: "spawn",
    agent: id,
    by: opts.auto ? "watcher" : process.env.TRIP_AGENT ?? "human",
    respawn: true,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });

  // 3. Free the name; tolerate exactly "session not found".
  tripKillTolerant(session);

  // 4. Checkpoint committed work into safety.
  const checkpoint = row.worktree
    ? checkpointWorktree(row.worktree, id, row.spawns)
    : null;

  // 5. Reclaim held tasks, judging each from bus.jsonl.
  reclaimWorking(team, id, roster.coordinator, checkpoint);

  // 6. The restart notice — written after the kill, so no live wait can
  // eat it; it lands in bus.jsonl as the audit of every restart.
  send(team, {
    from: RESERVED_SENDER,
    to: id,
    kind: "control",
    subject: "You were restarted",
    body:
      (opts.reason ? `Reason: ${opts.reason}. ` : "") +
      `Your history is in your archive/ — envelopes are plain JSON, id ` +
      `order is time order. Check git status before assuming a clean slate.`,
  });

  // 7. Create, with the resume preamble prefixed to the role prompt.
  const isCoordinator = id === roster.coordinator;
  const protocolRef = row.worktree
    ? ".tripping/PROTOCOL.md"
    : protocolPath(team);
  const basePrompt = isCoordinator
    ? coordinatorPrompt(team, id)
    : teammatePrompt(team, id, row.role, protocolRef);
  const prompt =
    `You are a fresh incarnation of ${id}. Read ${protocolRef}, run ` +
    `\`trip message read\` first, check \`git status\`, then ` +
    `\`trip message wait\`.\n\n` + basePrompt;
  tripExec(
    ["create", session, "--", ...engineCommand(row.engine, !!row.yolo, prompt)],
    {
      cwd: row.cwd,
      env: { ...process.env, TRIP_TEAM: team, TRIP_AGENT: id },
    }
  );

  // 8. Re-run the registration check, kind repair included.
  await verifyAgentRegistration(session, row.engine, opts.registrationTimeoutMs);
  return { id, session, checkpoint };
}
