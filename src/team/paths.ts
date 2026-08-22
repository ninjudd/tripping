import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

/** Root for all team state. Overridable for tests via TRIP_TEAMS_DIR. */
export function teamsRoot(): string {
  return process.env.TRIP_TEAMS_DIR ?? join(homedir(), ".trip", "teams");
}

export const teamDir = (team: string) => join(teamsRoot(), team);
export const teamJsonPath = (team: string) => join(teamDir(team), "team.json");
export const busPath = (team: string) => join(teamDir(team), "bus.jsonl");
export const tmpDir = (team: string) => join(teamDir(team), "tmp");
export const artifactsDir = (team: string) => join(teamDir(team), "artifacts");

export const agentDir = (team: string, id: string) =>
  join(teamDir(team), "agents", id);
export const inboxDir = (team: string, id: string) =>
  join(agentDir(team, id), "inbox");
export const workingDir = (team: string, id: string) =>
  join(agentDir(team, id), "working");
export const archiveDir = (team: string, id: string) =>
  join(agentDir(team, id), "archive");
export const deadDir = (team: string, id: string) =>
  join(agentDir(team, id), "dead");

/** Team and agent ids become directory and session names: no dots, no slashes. */
export function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

export function ensureTeamDirs(team: string): void {
  mkdirSync(tmpDir(team), { recursive: true });
  mkdirSync(artifactsDir(team), { recursive: true });
}

export function ensureAgentDirs(team: string, id: string): void {
  for (const d of [
    inboxDir(team, id),
    workingDir(team, id),
    archiveDir(team, id),
    deadDir(team, id),
  ]) {
    mkdirSync(d, { recursive: true });
  }
}
