/**
 * Spawning (§7) and its fail-first checks (§16, step 0). One chokepoint:
 * the CLI, team dispatch, and the Phase 3 watcher all inherit these.
 */
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { teamDir, validId } from "./paths.js";
import {
  Team,
  AgentRow,
  readTeam,
  writeTeam,
  DEFAULT_LIMITS,
} from "./roster.js";
import { bus, RESERVED_SENDER } from "./mailbox.js";
import { sessionName } from "./status.js";
import { agentJsonPath, readAgentConfig } from "../trip/log.js";
import {
  protocolPath,
  protocolText,
  teammatePrompt,
  agentsMdText,
} from "./protocol.js";

export type Engine = "claude" | "codex";

export interface SpawnOptions {
  role: string;
  engine?: Engine;
  worktree?: boolean;
  yolo?: boolean;
  /** Set by the Phase 3 watcher; the CLI always passes false. */
  auto?: boolean;
  /** Override the prompt (the coordinator's differs, §17). */
  prompt?: string;
  cwd?: string;
  /** How long to wait for trip on's agent.json (tests shorten it). */
  registrationTimeoutMs?: number;
  /** Set only by team start: this spawn IS the coordinator's own row. */
  coordinator?: boolean;
}

function trip(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("trip", args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
}

/** §9: every launch carries an autonomy tier; there is no interactive tier. */
export function engineCommand(engine: Engine, yolo: boolean, prompt: string): string[] {
  if (engine === "claude") {
    return ["claude", "--permission-mode", yolo ? "bypassPermissions" : "auto", prompt];
  }
  return yolo
    ? ["codex", "--dangerously-bypass-approvals-and-sandbox", prompt]
    : ["codex", "--approve-for-me", prompt];
}

/** Step 0 (§7/§16): fail first, before any worktree or session exists. */
export function checkSpawn(
  team: string,
  id: string,
  asCoordinator = false
): Team {
  const roster = readTeam(team);
  if (roster === null) {
    throw new Error(`no team.json for '${team}' — run: trip team init ${team}`);
  }
  const caller = process.env.TRIP_AGENT;
  if (caller && caller !== roster.coordinator) {
    throw new Error(
      `teammates cannot spawn or kill (v1). Ask the coordinator: trip message send coordinator --kind question`
    );
  }
  if (!validId(id)) throw new Error(`invalid agent id: ${id}`);
  if (asCoordinator) {
    // team start spawning the coordinator's own row (§17).
    if (id !== roster.coordinator)
      throw new Error(`the coordinator's id is '${roster.coordinator}'`);
  } else if (
    id === RESERVED_SENDER ||
    id === "coordinator" ||
    id === roster.coordinator
  ) {
    // The alias and the id that holds the role are both off-limits to
    // teammate spawns (§4); the reserved sender always is.
    throw new Error(`'${id}' is reserved`);
  }
  const existing = roster.agents[id];
  if (existing && !existing.killed_at) {
    throw new Error(
      `'${id}' is already live — respawn requires a kill first: trip team kill ${id}`
    );
  }
  if (!asCoordinator) {
    const live = Object.entries(roster.agents).filter(
      ([aid, row]) => aid !== roster.coordinator && !row.killed_at
    ).length;
    if (live >= roster.limits.max_agents) {
      throw new Error(
        `${live}/${roster.limits.max_agents} teammates live (limits.max_agents in ` +
          `~/.trip/teams/${team}/team.json). Free a slot: trip team kill <id>. ` +
          `Raising the cap is a human edit of team.json.`
      );
    }
  }
  return roster;
}

export function initTeam(
  team: string,
  opts: { maxAgents?: number; maxRespawns?: number; coordinator?: string } = {}
): Team {
  if (!validId(team)) throw new Error(`invalid team id: ${team}`);
  const existing = readTeam(team);
  if (existing) return existing;
  const roster: Team = {
    coordinator: opts.coordinator ?? "coordinator",
    limits: {
      max_agents: opts.maxAgents ?? DEFAULT_LIMITS.max_agents,
      max_respawns: opts.maxRespawns ?? DEFAULT_LIMITS.max_respawns,
    },
    agents: {},
  };
  if (roster.coordinator === RESERVED_SENDER)
    throw new Error(`'${RESERVED_SENDER}' is reserved`);
  writeTeam(team, roster);
  writeFileSync(protocolPath(team), protocolText(team));
  return roster;
}

/** Wait for trip on's agent.json, verify kind, repair by remove-then-write —
 *  leaving the file absent longer than the tailer's 300ms poll, or the old
 *  tailer never observes the removal (trip-primitives.md). */
export async function verifyAgentRegistration(
  session: string,
  engine: Engine,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const config = readAgentConfig(session);
    if (config) {
      if (config.kind === engine) return;
      unlinkSync(agentJsonPath(session));
      await new Promise((r) => setTimeout(r, 400)); // outlive the 300ms poll
      writeFileSync(
        agentJsonPath(session),
        JSON.stringify({ kind: engine, log_path: config.log_path }) + "\n"
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `agent.json never appeared for ${session} — trip on did not fire. ` +
          `Is the SessionStart hook configured? Autopsy: trip log ${session}`
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface SpawnResult {
  id: string;
  session: string;
  cwd: string;
  worktree?: string;
  branch?: string;
}

export async function spawnTeammate(
  team: string,
  id: string,
  opts: SpawnOptions
): Promise<SpawnResult> {
  const roster = checkSpawn(team, id, !!opts.coordinator);
  const engine: Engine = opts.engine ?? "claude";
  const session = sessionName(team, id);
  const repoCwd = opts.cwd ?? process.cwd();

  // Worktree for writer roles: wt/<id> in the team dir, branch team/<team>/<id>.
  let cwd = repoCwd;
  let worktree: string | undefined;
  let branch: string | undefined;
  if (opts.worktree) {
    worktree = join(teamDir(team), "wt", id);
    branch = `team/${team}/${id}`;
    mkdirSync(join(teamDir(team), "wt"), { recursive: true });
    if (!existsSync(worktree)) {
      execFileSync("git", ["worktree", "add", worktree, "-b", branch], {
        cwd: repoCwd,
        encoding: "utf8",
      });
    }
    // The worktree copy of the contract, re-entering context per compaction.
    const dotDir = join(worktree, ".tripping");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "PROTOCOL.md"), protocolText(team));
    const agentsMd = join(worktree, "AGENTS.md");
    if (!existsSync(agentsMd)) writeFileSync(agentsMd, agentsMdText(team));
    const claudeMd = join(worktree, "CLAUDE.md");
    if (!existsSync(claudeMd)) symlinkSync("AGENTS.md", claudeMd);
    cwd = worktree;
  }

  // Roster row before create: spawned_at first is what §6 derives from.
  const prior = roster.agents[id];
  const row: AgentRow = {
    role: opts.role,
    engine,
    session,
    cwd,
    ...(worktree ? { worktree, branch } : {}),
    spawned_at: new Date().toISOString(),
    spawns: (prior?.spawns ?? 0) + 1,
    restarts_since_human: 0,
  };
  roster.agents[id] = row;
  writeTeam(team, roster);
  bus(team, {
    event: "spawn",
    agent: id,
    by: opts.auto ? "watcher" : process.env.TRIP_AGENT ?? "human",
    engine,
  });

  const protocolRef = worktree
    ? ".tripping/PROTOCOL.md"
    : protocolPath(team);
  const prompt =
    opts.prompt ?? teammatePrompt(team, id, opts.role, protocolRef);
  trip(["create", session, "--", ...engineCommand(engine, !!opts.yolo, prompt)], {
    cwd,
    env: { ...process.env, TRIP_TEAM: team, TRIP_AGENT: id },
  });

  await verifyAgentRegistration(session, engine, opts.registrationTimeoutMs);
  return { id, session, cwd, worktree, branch };
}

/** Kill: trip kill first — the name frees at the daemon regardless of what
 *  happens next — then stamp killed_at; rerunning is the crash recovery. */
export function killTeammate(team: string, id: string): void {
  const roster = readTeam(team);
  if (roster === null) throw new Error(`no team.json for '${team}'`);
  const caller = process.env.TRIP_AGENT;
  if (caller && caller !== roster.coordinator) {
    throw new Error(
      `teammates cannot spawn or kill (v1). Ask the coordinator: trip message send coordinator --kind question`
    );
  }
  if (!roster.agents[id]) throw new Error(`'${id}' is not on the roster`);
  try {
    trip(["kill", sessionName(team, id)]);
  } catch {
    /* "session not found" — already dead; stamping is the recovery */
  }
  roster.agents[id].killed_at = new Date().toISOString();
  writeTeam(team, roster);
  bus(team, { event: "kill", agent: id, by: caller ?? "human" });
}
