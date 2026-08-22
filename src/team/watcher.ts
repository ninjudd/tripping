/**
 * The Phase 3 watcher (§12): the reconcile sweep, doorbell delivery behind
 * the §8 screen guard, death detection, and the §16 breaker's edges.
 * Everything derives from directories, bus.jsonl, and trip's session list —
 * nothing from process memory — so a watcher crash mid-sequence or two
 * concurrent watchers converge on the same state.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { readTeam, writeTeam } from "./roster.js";
import {
  bus,
  readBus,
  send,
  workingEntries,
  RESERVED_SENDER,
} from "./mailbox.js";
import { sessionAlive, tripExec } from "./spawn.js";
import { deriveStatus, sessionName } from "./status.js";
import { inboxDir, tmpDir } from "./paths.js";
import { respawnTeammate, REDELIVERY_CAP } from "./respawn.js";

/** §8's guard: the permission-prompt signatures worth never typing into.
 *  A heuristic, deliberately erring toward not injecting. */
const PROMPT_SIGNATURES = [
  /do you want/i,
  /don't ask again/i,
  /allow .* to/i,
  /\bapprove\b/i,
  /\by\/n\b/i,
];

export function screenParked(session: string): boolean {
  let screen: string;
  try {
    screen = tripExec(["screen", session]);
  } catch {
    return false; // no screen to read; nothing to type into either
  }
  return PROMPT_SIGNATURES.some((sig) => sig.test(screen));
}

const inboxCount = (team: string, id: string): number => {
  const dir = inboxDir(team, id);
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).length
    : 0;
};

/** One pass of the reconcile sweep. Returns what it did, for the log. */
export async function sweepOnce(team: string): Promise<string[]> {
  const actions: string[] = [];
  const roster = readTeam(team);
  if (roster === null) return ["no team.json; nothing to sweep"];
  const lines = readBus(team);

  for (const [id, row] of Object.entries(roster.agents)) {
    if (row.killed_at) continue;
    const session = sessionName(team, id);
    const alive = sessionAlive(session);

    // §16: the breaker resets on a result whose envelope from is the
    // agent's own id, arriving after the incarnation it vouches for.
    if ((row.restarts_since_human ?? 0) > 0 && row.spawned_at) {
      // bus timestamps are floor-to-second; spawned_at keeps milliseconds.
      // Same-second counts as after — the spawn always precedes the send.
      const since = Math.floor(Date.parse(row.spawned_at) / 1000);
      const healthy = lines.some(
        (l) =>
          l.event === "message" &&
          l.kind === "result" &&
          l.from === id &&
          l.t >= since
      );
      if (healthy) {
        row.restarts_since_human = 0;
        writeTeam(team, roster);
        actions.push(`${id}: result seen — breaker reset`);
      }
    }

    if (!alive) {
      const restarts = row.restarts_since_human ?? 0;
      if (restarts >= roster.limits.max_respawns) {
        if (!row.breaker_noted) {
          send(team, {
            from: RESERVED_SENDER,
            to: roster.coordinator,
            kind: "note",
            subject: `${id} crashed ${restarts}x; leaving it down`,
            body:
              `The crash-loop breaker tripped (limits.max_respawns). ` +
              `Autopsy: trip log ${session}. A deliberate ` +
              `trip team respawn ${id} resets the breaker.`,
          });
          row.breaker_noted = true;
          writeTeam(team, roster);
          actions.push(`${id}: breaker tripped — coordinator noted`);
        }
        continue;
      }
      try {
        await respawnTeammate(team, id, {
          auto: true,
          reason: "session died",
        });
        actions.push(`${id}: dead session — respawned`);
      } catch (err) {
        actions.push(`${id}: respawn failed — ${(err as Error).message}`);
      }
      continue;
    }

    // Alive: doorbells, behind the guard, only at the statuses §8 names.
    const status = deriveStatus(team, id);
    const unread = inboxCount(team, id);
    const held = workingEntries(team, id);
    if (status === "idle" && (unread > 0 || held.length > 0)) {
      if (screenParked(session)) {
        // Never type into a prompt. Once per park: flag it, tell the
        // coordinator, audit later suppressions instead of mailing them.
        if (!row.park_noted) {
          send(team, {
            from: RESERVED_SENDER,
            to: roster.coordinator,
            kind: "note",
            subject: `${id} is parked at a permission prompt`,
            body: `Attach and answer it: trip attach ${session}`,
          });
          row.park_noted = true;
          writeTeam(team, roster);
          actions.push(`${id}: parked — coordinator noted`);
        } else {
          bus(team, { event: "doorbell_suppressed", agent: id });
        }
      } else {
        if (row.park_noted) {
          delete row.park_noted;
          writeTeam(team, roster);
        }
        if (unread > 0) {
          tripExec(["send", session, "New message. Run: trip message read"]);
          actions.push(`${id}: idle with mail — doorbell rung`);
        } else {
          // The §8 nudge: idle holding a task — remind, never reclaim.
          tripExec([
            "send",
            session,
            `You still hold task ${held[0].file.replace(/\.json$/, "")} — finish it or send its result.`,
          ]);
          actions.push(`${id}: idle holding a task — nudged`);
        }
      }
    }
  }

  // GC hour-old staging strays.
  const staging = tmpDir(team);
  if (existsSync(staging)) {
    for (const f of readdirSync(staging)) {
      const path = join(staging, f);
      try {
        if (Date.now() - statSync(path).mtimeMs > 3600_000) {
          unlinkSync(path);
          actions.push(`gc: removed stale tmp/${f}`);
        }
      } catch {
        /* raced away */
      }
    }
  }
  return actions;
}

/** The foreground loop: `trip team watcher`. */
export async function watchTeam(
  team: string,
  opts: { intervalMs?: number; once?: boolean } = {}
): Promise<void> {
  const interval = opts.intervalMs ?? 5000;
  for (;;) {
    const actions = await sweepOnce(team);
    for (const a of actions) process.stdout.write(`${a}\n`);
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, interval));
  }
}
