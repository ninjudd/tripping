#!/usr/bin/env node
/**
 * trip-team — the management verbs, dispatched as `trip team <verb>`.
 * ls and watch are open to every agent; start, spawn, and kill are
 * coordinator-or-human verbs — the gate lives in team/spawn.ts.
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import {
  initTeam,
  spawnTeammate,
  killTeammate,
  sessionAlive,
  Engine,
} from "../team/spawn.js";
import { readTeam } from "../team/roster.js";
import { deriveStatus, sessionName } from "../team/status.js";
import { inboxDir, workingDir, deadDir, teamJsonPath } from "../team/paths.js";
import { coordinatorPrompt } from "../team/protocol.js";
import { respawnTeammate } from "../team/respawn.js";
import { requeueMessage } from "../team/mailbox.js";
import { watchTeam } from "../team/watcher.js";
import {
  dispatchTasks,
  awaitResults,
  joinFailed,
  TaskSpec,
} from "../team/dispatch.js";
import { readFileSync } from "fs";

function fail(message: string): never {
  process.stderr.write(`trip team: ${message}\n`);
  process.exit(2);
}

interface Flags {
  positional: string[];
  [flag: string]: string | boolean | string[] | undefined;
}

function parseFlags(argv: string[], takesValue: Set<string>, booleans: Set<string>): Flags {
  const out: Flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.has(name)) {
      out[name] = true;
    } else if (takesValue.has(name)) {
      const value = argv[++i];
      if (value === undefined) fail(`--${name} needs a value`);
      out[name] = value;
    } else {
      fail(`unknown flag --${name}`);
    }
  }
  return out;
}

function engineFlag(flags: Flags): Engine | undefined {
  const engine = flags.engine as string | undefined;
  if (engine === undefined) return undefined;
  if (engine !== "claude" && engine !== "codex")
    fail(`unknown engine '${engine}' — use --engine claude|codex`);
  return engine;
}

function checkLaunched(result: { error?: Error; status: number | null }): never {
  if (result.error) fail("trip is not on PATH — install trip, or check PATH");
  process.exit(result.status ?? 0);
}

function teamFromEnv(flags: Flags): string {
  const team = (flags.team as string) ?? process.env.TRIP_TEAM;
  if (!team) fail("TRIP_TEAM is not set and no --team given. Start with: trip team start <name>");
  return team;
}

const count = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);

  switch (verb) {
    case "init": {
      const flags = parseFlags(rest, new Set(["max-agents", "max-respawns", "coordinator"]), new Set());
      const name = flags.positional[0];
      if (!name) fail("usage: trip team init <name> [--max-agents N] [--max-respawns N] [--coordinator id]");
      initTeam(name, {
        maxAgents: flags["max-agents"] ? Number(flags["max-agents"]) : undefined,
        maxRespawns: flags["max-respawns"] ? Number(flags["max-respawns"]) : undefined,
        coordinator: flags.coordinator as string | undefined,
      });
      process.stdout.write(`team '${name}' ready — limits in ${teamJsonPath(name)}\n`);
      return;
    }

    case "start": {
      const flags = parseFlags(rest, new Set(["engine", "coordinator", "max-agents", "max-respawns", "model", "effort"]), new Set(["yolo", "detach"]));
      const name = flags.positional[0] ?? process.env.TRIP_TEAM;
      if (!name) fail("usage: trip team start <name> [--engine claude|codex] [--model m] [--effort e] [--yolo] [--detach]");
      const roster = initTeam(name, {
        coordinator: flags.coordinator as string | undefined,
        maxAgents: flags["max-agents"] ? Number(flags["max-agents"]) : undefined,
        maxRespawns: flags["max-respawns"] ? Number(flags["max-respawns"]) : undefined,
      });
      const coordinator = roster.coordinator;
      const session = sessionName(name, coordinator);

      // Re-running start on a live team just attaches; a dead coordinator
      // session recreates (§17). Liveness comes from trip's session list —
      // the session directory outlives every crash, so file existence
      // proves nothing (trip-primitives.md).
      if (!sessionAlive(session)) {
        const result = await spawnTeammate(name, coordinator, {
          role: "coordinator",
          engine: engineFlag(flags) ?? "claude",
          yolo: !!flags.yolo,
          model: flags.model as string | undefined,
          effort: flags.effort as string | undefined,
          prompt: coordinatorPrompt(name, coordinator),
          coordinator: true,
          // The coordinator's cwd is wherever start ran (§17); no worktree.
        });
        if (result.protocolReference)
          process.stdout.write(`${result.protocolReference}\n`);
      }
      if (flags.detach) {
        process.stdout.write(`coordinator running: ${session} — attach with: trip attach ${session}\n`);
        return;
      }
      checkLaunched(spawnSync("trip", ["attach", session], { stdio: "inherit" }));
    }

    case "spawn": {
      const flags = parseFlags(rest, new Set(["role", "engine", "team", "model", "effort"]), new Set(["worktree", "yolo"]));
      const id = flags.positional[0];
      if (!id || !flags.role)
        fail('usage: trip team spawn <id> --role "..." [--engine claude|codex] [--model m] [--effort e] [--worktree] [--yolo]');
      const team = teamFromEnv(flags);
      const result = await spawnTeammate(team, id, {
        role: flags.role as string,
        engine: engineFlag(flags) ?? "claude",
        worktree: !!flags.worktree,
        yolo: !!flags.yolo,
        model: flags.model as string | undefined,
        effort: flags.effort as string | undefined,
      });
      process.stdout.write(
        `spawned ${result.id} (${result.session})` +
          (result.worktree ? ` in ${result.worktree} on ${result.branch}` : "") +
          "\n"
      );
      if (result.protocolReference)
        process.stdout.write(`${result.protocolReference}\n`);
      return;
    }

    case "ls": {
      const flags = parseFlags(rest, new Set(["team"]), new Set());
      const team = teamFromEnv(flags);
      const roster = readTeam(team);
      if (!roster) fail(`no team.json for '${team}' — run: trip team init ${team}`);
      const rows = Object.entries(roster.agents);
      const live = rows.filter(([id, r]) => id !== roster.coordinator && !r.killed_at).length;
      process.stdout.write(
        `team ${team} — ${live}/${roster.limits.max_agents} teammates live (limits: team.json)\n`
      );
      // Size the id and engine/tuning columns from the rows, the way
      // trip's own ls does — a tuned row (`claude/opus high`) outgrows any
      // fixed constant eventually.
      const engineCell = (row: (typeof rows)[number][1]) =>
        row.engine +
        (row.model ? `/${row.model}` : "") +
        (row.effort ? ` ${row.effort}` : "");
      const idWidth = Math.max(14, ...rows.map(([id]) => id.length));
      const engineWidth = Math.max(6, ...rows.map(([, r]) => engineCell(r).length));
      for (const [id, row] of rows) {
        // §16: flag a roster/daemon mismatch — the roster says live but the
        // daemon has no such session.
        const gone = !row.killed_at && !sessionAlive(row.session);
        const status = row.killed_at
          ? "dead"
          : gone
            ? "gone?"
            : deriveStatus(team, id);
        const age = row.spawned_at
          ? `${Math.round((Date.now() - Date.parse(row.spawned_at)) / 60000)}m`
          : "?";
        const mail = `${count(inboxDir(team, id))} in / ${count(workingDir(team, id))} held / ${count(deadDir(team, id))} dead`;
        process.stdout.write(
          `  ${id.padEnd(idWidth)} ${engineCell(row).padEnd(engineWidth)} ${String(status).padEnd(8)} ` +
            `age ${age.padEnd(7)} spawns ${String(row.spawns ?? 1).padEnd(3)} ${mail}  ${row.role}` +
            (gone ? `  [session gone — trip team kill ${id}]` : "") +
            "\n"
        );
      }
      return;
    }

    case "kill": {
      const flags = parseFlags(rest, new Set(["team"]), new Set());
      const id = flags.positional[0];
      if (!id) fail("usage: trip team kill <id>");
      killTeammate(teamFromEnv(flags), id);
      process.stdout.write(`killed ${id}\n`);
      return;
    }

    case "watch": {
      const flags = parseFlags(rest, new Set(["team"]), new Set());
      const id = flags.positional[0];
      if (!id) fail("usage: trip team watch <id>");
      const team = teamFromEnv(flags);
      checkLaunched(
        spawnSync("trip", ["log", sessionName(team, id), "--follow"], {
          stdio: "inherit",
        })
      );
    }

    case "respawn": {
      const flags = parseFlags(rest, new Set(["team", "reason"]), new Set(["force"]));
      const id = flags.positional[0];
      if (!id) fail('usage: trip team respawn <id> [--reason "..."] [--force]');
      const result = await respawnTeammate(teamFromEnv(flags), id, {
        reason: flags.reason as string | undefined,
        force: !!flags.force,
      });
      process.stdout.write(
        `respawned ${result.id} (${result.session})` +
          (result.checkpoint ? ` — worktree checkpointed at ${result.checkpoint.slice(0, 8)}` : "") +
          "\n"
      );
      return;
    }

    case "requeue": {
      const flags = parseFlags(rest, new Set(["team"]), new Set());
      const [id, msgId] = flags.positional;
      if (!id || !msgId) fail("usage: trip team requeue <id> <msg-id>");
      const source = requeueMessage(teamFromEnv(flags), id, msgId);
      process.stdout.write(`re-queued ${msgId} from ${source}/ into ${id}'s inbox\n`);
      return;
    }

    case "dispatch": {
      const flags = parseFlags(rest, new Set(["team", "timeout"]), new Set(["wait"]));
      const file = flags.positional[0];
      if (!file)
        fail('usage: trip team dispatch <tasks.json> [--wait] [--timeout <s>] — file: [{"to","subject","body"}]');
      const team = teamFromEnv(flags);
      const from = process.env.TRIP_AGENT ?? "coordinator";
      let tasks: TaskSpec[];
      try {
        tasks = JSON.parse(readFileSync(file, "utf8")) as TaskSpec[];
      } catch (err) {
        fail(`could not read ${file}: ${(err as Error).message}`);
      }
      if (!Array.isArray(tasks) || tasks.some((t) => !t.to || !t.subject || t.body === undefined))
        fail(`${file} must be a JSON array of {to, subject, body}`);
      const outcomes = dispatchTasks(team, from, tasks);
      for (const o of outcomes)
        process.stdout.write(`dispatched to ${o.to}: ${o.subject} (thread ${o.thread})\n`);
      if (!flags.wait) return;
      const timeout = Number((flags.timeout as string) ?? "3600");
      const { done, pending } = await awaitResults(team, outcomes, {
        timeoutMs: timeout * 1000,
      });
      for (const o of done)
        process.stdout.write(
          joinFailed(o)
            ? `FAILED ${o.thread} (${o.subject}) — dead-lettered; see coordinator inbox\n`
            : `done ${o.thread} (${o.subject}) — result from ${o.resultFrom}\n`
        );
      if (pending.length > 0) {
        for (const o of pending)
          process.stderr.write(`timed out waiting on ${o.thread} (${o.to}: ${o.subject})\n`);
        process.exit(1);
      }
      process.stdout.write("all results in — run: trip message read\n");
      return;
    }

    case "watcher": {
      const flags = parseFlags(rest, new Set(["team", "interval"]), new Set(["once"]));
      const team = teamFromEnv(flags);
      const interval = Number((flags.interval as string) ?? "5");
      if (!Number.isFinite(interval) || interval < 1)
        fail("--interval must be a positive number of seconds");
      process.stdout.write(`watching team ${team} (every ${interval}s)\n`);
      await watchTeam(team, {
        intervalMs: interval * 1000,
        once: !!flags.once,
      });
      return;
    }

    default:
      fail("usage: trip team <init|start|spawn|respawn|requeue|dispatch|ls|kill|watch|watcher>");
  }
}


main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
