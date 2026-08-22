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
  Engine,
} from "../team/spawn.js";
import { readTeam } from "../team/roster.js";
import { deriveStatus, sessionName } from "../team/status.js";
import { inboxDir, workingDir, deadDir } from "../team/paths.js";
import { coordinatorPrompt } from "../team/protocol.js";
import { sessionDir as sessionLogDir } from "../trip/log.js";

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
      process.stdout.write(`team '${name}' ready — limits in ~/.trip/teams/${name}/team.json\n`);
      return;
    }

    case "start": {
      const flags = parseFlags(rest, new Set(["engine", "coordinator", "max-agents", "max-respawns"]), new Set(["yolo", "detach"]));
      const name = flags.positional[0] ?? process.env.TRIP_TEAM;
      if (!name) fail("usage: trip team start <name> [--engine claude|codex] [--yolo] [--detach]");
      const roster = initTeam(name, {
        coordinator: flags.coordinator as string | undefined,
        maxAgents: flags["max-agents"] ? Number(flags["max-agents"]) : undefined,
        maxRespawns: flags["max-respawns"] ? Number(flags["max-respawns"]) : undefined,
      });
      const coordinator = roster.coordinator;
      const session = sessionName(name, coordinator);

      // Re-running start on a live team just attaches (§17).
      const row = roster.agents[coordinator];
      const alive = row && !row.killed_at && existsSync(sessionLogDir(session));
      if (!alive) {
        await spawnTeammate(name, coordinator, {
          role: "coordinator",
          engine: (flags.engine as Engine) ?? "claude",
          yolo: !!flags.yolo,
          prompt: coordinatorPrompt(name, coordinator),
          coordinator: true,
          // The coordinator's cwd is wherever start ran (§17); no worktree.
        });
      }
      if (flags.detach) {
        process.stdout.write(`coordinator running: ${session} — attach with: trip attach ${session}\n`);
        return;
      }
      const attach = spawnSync("trip", ["attach", session], { stdio: "inherit" });
      process.exit(attach.status ?? 0);
    }

    case "spawn": {
      const flags = parseFlags(rest, new Set(["role", "engine", "team"]), new Set(["worktree", "yolo"]));
      const id = flags.positional[0];
      if (!id || !flags.role)
        fail('usage: trip team spawn <id> --role "..." [--engine claude|codex] [--worktree] [--yolo]');
      const team = teamFromEnv(flags);
      const result = await spawnTeammate(team, id, {
        role: flags.role as string,
        engine: (flags.engine as Engine) ?? "claude",
        worktree: !!flags.worktree,
        yolo: !!flags.yolo,
      });
      process.stdout.write(
        `spawned ${result.id} (${result.session})` +
          (result.worktree ? ` in ${result.worktree} on ${result.branch}` : "") +
          "\n"
      );
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
      for (const [id, row] of rows) {
        const status = row.killed_at ? "dead" : deriveStatus(team, id);
        const age = row.spawned_at
          ? `${Math.round((Date.now() - Date.parse(row.spawned_at)) / 60000)}m`
          : "?";
        const mail = `${count(inboxDir(team, id))} in / ${count(workingDir(team, id))} held / ${count(deadDir(team, id))} dead`;
        process.stdout.write(
          `  ${id.padEnd(14)} ${row.engine.padEnd(6)} ${String(status).padEnd(8)} ` +
            `age ${age.padEnd(7)} spawns ${String(row.spawns ?? 1).padEnd(3)} ${mail}  ${row.role}\n`
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
      const watch = spawnSync("trip", ["log", sessionName(team, id), "--follow"], {
        stdio: "inherit",
      });
      process.exit(watch.status ?? 0);
    }

    case "respawn":
    case "requeue":
    case "dispatch":
      fail(`'${verb}' lands in Phase 3 (the watcher) — not implemented yet`);

    default:
      fail("usage: trip team <init|start|spawn|ls|kill|watch>");
  }
}


main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
