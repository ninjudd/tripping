/**
 * The Phase 3 watcher (§12): the reconcile sweep, doorbell delivery behind
 * the §8 screen guard, death detection, and the §16 breaker's edges.
 * Everything derives from directories, bus.jsonl, and trip's session list —
 * nothing from process memory — so a watcher crash mid-sequence or two
 * concurrent watchers converge on the same state.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { AgentRow, readTeam, updateRow } from "./roster.js";
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
import { reclaimWorking, respawnTeammate, REDELIVERY_CAP } from "./respawn.js";

/** §8's guard. Two refinements over "does the word appear anywhere":
 *
 *  Only the tail is read. A real prompt is the last thing rendered; the same
 *  words in scrollback are a teammate describing its work.
 *
 *  And the weak signatures need corroboration. "approve" and "allow X to" are
 *  words teammates write constantly ("ask the reviewer to approve"), so alone
 *  they mean nothing; paired with an affordance — a y/n, a selector caret —
 *  they are a prompt. The strong signatures stand on their own.
 *
 *  Still deliberately biased toward not injecting: typing into a real prompt
 *  answers it. PARK_ESCALATE_AFTER is what keeps that bias from stranding
 *  mail forever when the guard is wrong. */
const TAIL_LINES = 12;

/** The engines do not agree on the glyph. Claude renders its selector as ❯
 *  (U+276F), Codex as › (U+203A) — a real Codex approval prompt read as
 *  unparked until this class covered both, and the watcher would have typed
 *  a doorbell straight into it. Kept to the arrow-like glyphs a TUI actually
 *  draws; never ASCII '>', which is a shell prompt and a quoted command. */
const SELECTOR = "[❯›▸‣⯈]";

const STRONG_SIGNATURES = [
  /do you want/i,
  /don't ask again/i,
  /\by\s*\/\s*n\b/i,
  new RegExp(`^\\s*${SELECTOR}\\s*\\d+[.)]`, "m"), // selector on a numbered choice
];

const WEAK_SIGNATURES = [/\bapprove\b/i, /allow .* to/i];

/** How a prompt offers to be answered. Deliberately not ASCII '>': that is a
 *  shell prompt and the start of a quoted command line. */
const AFFORDANCES = [
  /\by\s*\/\s*n\b/i,
  new RegExp(`^\\s*${SELECTOR}`, "m"),
];

/** After this many consecutive suppressed doorbells the park stops being a
 *  transient and becomes something a human has to look at — either a prompt
 *  nobody answered or a guard that is wrong about the screen. Either way the
 *  mail is stranded, which §8 never intends. */
export const PARK_ESCALATE_AFTER = 10;

export function screenParked(session: string): boolean {
  let screen: string;
  try {
    screen = tripExec(["screen", session]);
  } catch {
    return false; // no screen to read; nothing to type into either
  }
  const tail = screen
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
  if (STRONG_SIGNATURES.some((sig) => sig.test(tail))) return true;
  return (
    WEAK_SIGNATURES.some((sig) => sig.test(tail)) &&
    AFFORDANCES.some((sig) => sig.test(tail))
  );
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

    // respawnTeammate re-reads and writes team.json, so `roster` goes stale
    // the moment we call it. Every mutation below therefore re-reads, and
    // applies the same change to the in-loop view so later reads agree.
    const persist = (mutate: (r: AgentRow) => void) => {
      mutate(row);
      updateRow(team, id, mutate);
    };

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
        persist((r) => {
          r.restarts_since_human = 0;
        });
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
          persist((r) => {
            r.breaker_noted = true;
          });
          actions.push(`${id}: breaker tripped — coordinator noted`);
        }
        // The teammate is dead and staying dead, so nothing will ever send
        // the results of what it still holds. Judge those tasks now, exactly
        // as a respawn would, except that re-delivery to a session that will
        // not restart is pointless: they all dead-letter, and the park mail
        // rides the task's own thread so a dispatch --wait join fails fast
        // instead of running out its timeout (§15). Idempotent — working/ is
        // empty on every later sweep.
        const stranded = workingEntries(team, id).length;
        if (stranded > 0) {
          reclaimWorking(team, id, roster.coordinator, null, {
            terminal: true,
          });
          actions.push(
            `${id}: breaker down — ${stranded} held task(s) dead-lettered`
          );
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
          persist((r) => {
            r.park_noted = true;
            r.park_suppressed = 0;
          });
          actions.push(`${id}: parked — coordinator noted`);
        } else {
          bus(team, { event: "doorbell_suppressed", agent: id });
          const eaten = (row.park_suppressed ?? 0) + 1;
          persist((r) => {
            r.park_suppressed = eaten;
          });
          // The escape hatch. An idle agent's screen does not change on its
          // own, so a wrong verdict here is stable and the mail would sit
          // undelivered forever. Say so once, differently, and name both
          // readings — the human can settle which it is in one look.
          if (eaten >= PARK_ESCALATE_AFTER && !row.park_escalated) {
            send(team, {
              from: RESERVED_SENDER,
              to: roster.coordinator,
              kind: "note",
              subject: `${id} has been parked for ${eaten} sweeps — mail is stranded`,
              body:
                `Its doorbell has been suppressed ${eaten} times, so ${unread} ` +
                `message(s) are undelivered. Either a prompt nobody answered, ` +
                `or the guard is misreading the screen — trip screen ${session} ` +
                `says which. If it is not a prompt, deliver by hand with: ` +
                `trip send ${session} "New message. Run: trip message read".`,
            });
            persist((r) => {
              r.park_escalated = true;
            });
            actions.push(`${id}: parked ${eaten} sweeps — escalated`);
          }
        }
      } else {
        if (row.park_noted) {
          persist((r) => {
            delete r.park_noted;
            delete r.park_suppressed;
            delete r.park_escalated;
          });
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
