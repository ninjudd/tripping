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
  yolo?: boolean;
  /** Model and effort are per-teammate, replayed faithfully on respawn. */
  model?: string;
  effort?: string;
  spawned_at?: string;
  spawns?: number;
  restarts_since_human?: number;
  killed_at?: string;
  /** Watcher bookkeeping: a parked-at-prompt note was sent this park. */
  park_noted?: boolean;
  /** Watcher bookkeeping: the breaker-tripped note was sent this outage. */
  breaker_noted?: boolean;
  /** Watcher bookkeeping: consecutive doorbells the park guard has eaten. */
  park_suppressed?: number;
  /** Watcher bookkeeping: the long-park escalation was sent this park. */
  park_escalated?: boolean;
}

export interface Team {
  coordinator: string;
  limits: { max_agents: number; max_respawns: number };
  agents: Record<string, AgentRow>;
}

export const DEFAULT_LIMITS = { max_agents: 4, max_respawns: 3 };

export function readTeam(team: string): Team | null {
  let raw: string;
  try {
    raw = readFileSync(teamJsonPath(team), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: Team;
  try {
    parsed = JSON.parse(raw) as Team;
  } catch {
    // Fails closed, naming the path and the recovery (§7 step 0).
    throw new Error(
      `team.json for '${team}' is corrupt at ${teamJsonPath(team)} — ` +
        `fix it by hand, or move it aside and rerun: trip team init ${team}`
    );
  }
  // A hand-built file missing limits gets the defaults written back,
  // with a note (§16); agents likewise normalizes to an empty roster.
  let repaired = false;
  if (!parsed.agents || typeof parsed.agents !== "object") {
    parsed.agents = {};
    repaired = true;
  }
  if (!parsed.limits || typeof parsed.limits !== "object") {
    parsed.limits = { ...DEFAULT_LIMITS };
    repaired = true;
  } else {
    // Replace offending fields individually — spreading a known-bad object
    // over the defaults puts the bad value back on top.
    for (const field of ["max_agents", "max_respawns"] as const) {
      const value = parsed.limits[field];
      if (!Number.isInteger(value) || (value as number) <= 0) {
        parsed.limits[field] = DEFAULT_LIMITS[field];
        repaired = true;
      }
    }
  }
  if (!parsed.coordinator) {
    parsed.coordinator = "coordinator";
    repaired = true;
  }
  if (repaired) {
    writeTeam(team, parsed);
    process.stderr.write(
      `note: team.json for '${team}' was missing fields; defaults written back\n`
    );
  }
  return parsed;
}

/** All team.json writes stage in tmp/ and land by rename, like the maildir. */
export function writeTeam(team: string, data: Team): void {
  mkdirSync(tmpDir(team), { recursive: true });
  mkdirSync(teamDir(team), { recursive: true });
  const staging = join(tmpDir(team), `team-${newId()}.json`);
  writeFileSync(staging, JSON.stringify(data, null, 2) + "\n");
  renameSync(staging, teamJsonPath(team));
}

/** Re-read, mutate one row, write. Never hold a roster object across a call
 *  that also writes the roster: the stale write-back silently undoes the
 *  other writer — a respawn's spawned_at and breaker counters especially. */
export function updateRow(
  team: string,
  id: string,
  mutate: (row: AgentRow) => void
): void {
  const roster = readTeam(team);
  const row = roster?.agents[id];
  if (!roster || !row) return;
  mutate(row);
  writeTeam(team, roster);
}

/**
 * The address `coordinator` is a reserved alias, resolved through team.json
 * to whichever id holds the role. Without a team.json it resolves to itself.
 */
export function resolveAddress(team: string, to: string): string {
  if (to !== "coordinator") return to;
  return readTeam(team)?.coordinator ?? "coordinator";
}
