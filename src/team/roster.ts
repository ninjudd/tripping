import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { teamDir, teamJsonPath, tmpDir } from "./paths.js";
import { newId } from "./envelope.js";

export interface AgentRow {
  role: string;
  engine: "claude" | "codex";
  session: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  spawned_at?: string;
  spawns?: number;
  restarts_since_human?: number;
  killed_at?: string;
}

export interface Team {
  coordinator: string;
  limits: { max_agents: number; max_respawns: number };
  agents: Record<string, AgentRow>;
}

export const DEFAULT_LIMITS = { max_agents: 4, max_respawns: 3 };

export function readTeam(team: string): Team | null {
  try {
    return JSON.parse(readFileSync(teamJsonPath(team), "utf8")) as Team;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err; // corrupt team.json fails closed, never silently
  }
}

/** All team.json writes stage in tmp/ and land by rename, like the maildir. */
export function writeTeam(team: string, data: Team): void {
  mkdirSync(tmpDir(team), { recursive: true });
  mkdirSync(teamDir(team), { recursive: true });
  const staging = join(tmpDir(team), `team-${newId()}.json`);
  writeFileSync(staging, JSON.stringify(data, null, 2) + "\n");
  renameSync(staging, teamJsonPath(team));
}

/**
 * The address `coordinator` is a reserved alias, resolved through team.json
 * to whichever id holds the role. Without a team.json it resolves to itself.
 */
export function resolveAddress(team: string, to: string): string {
  if (to !== "coordinator") return to;
  return readTeam(team)?.coordinator ?? "coordinator";
}
