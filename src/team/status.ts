/**
 * Status derivation (§6): read the tail of the session's log.jsonl on
 * demand. Stateless — no status file to go stale. Events are scoped to
 * after max(last agent_session_start, roster spawned_at), because the log
 * outlives the session and a respawn must not read its predecessor's tail.
 */
import { readLog, AGENT_EVENT_TYPES, TripEvent } from "../trip/log.js";
import { readTeam } from "./roster.js";

export type Status = "idle" | "starting" | "working" | "waiting" | "unknown";

/** How long a spawned session may stay silent before starting stops being
 *  the story — several times the registration timeout. */
export const STARTING_WINDOW_SECONDS = 60;

export function sessionName(team: string, id: string): string {
  return `${team}-${id}`;
}

/** §6's one per-engine branch: a shell tool call whose input runs
 *  `trip message wait`. The two engines record the same act differently.
 *
 *  Claude logs a `Bash` call with the command in `input.command`.
 *
 *  Codex logs an `exec` call whose `input` is a *source string* — the
 *  JavaScript it runs, with the command embedded in it, like
 *  `const r = await tools.exec_command({"cmd":"trip message wait"})`. trip
 *  produces those only once it normalizes `custom_tool_call`
 *  ([trip#3](https://github.com/ninjudd/trip/pull/3)); before that no `exec`
 *  events exist and this branch simply never fires, which is the old
 *  Claude-only behaviour rather than a regression. */
const WAIT_COMMAND = /\btrip(?:-message|-msg)?\s+(?:message\s+|msg\s+)?wait\b/;

function isMessageWaitCall(event: TripEvent): boolean {
  if (event.type !== "agent_tool_call") return false;
  if (event.name === "Bash") {
    const command = (event.input as { command?: unknown } | undefined)?.command;
    return typeof command === "string" && WAIT_COMMAND.test(command);
  }
  if (event.name === "exec") {
    return typeof event.input === "string" && WAIT_COMMAND.test(event.input);
  }
  return false;
}

export function deriveStatus(team: string, id: string): Status {
  const events = readLog(sessionName(team, id)).filter((e) =>
    AGENT_EVENT_TYPES.has(e.type)
  );

  // Scope boundary: the current incarnation only.
  let boundary = 0;
  for (const e of events) {
    if (e.type === "agent_session_start") boundary = Math.max(boundary, e.t);
  }
  const spawnedAt = readTeam(team)?.agents[id]?.spawned_at;
  if (spawnedAt) {
    const t = Date.parse(spawnedAt) / 1000;
    if (Number.isFinite(t)) boundary = Math.max(boundary, t);
  }

  const scoped = events.filter(
    (e) => e.t >= boundary && e.type !== "agent_session_start"
  );
  if (scoped.length === 0) {
    // Nothing after the boundary: a fresh spawn window derives as starting,
    // but the window is bounded — a session silent long past registration is
    // §6's spawn-failure row, and the honest answer is unknown, which tells
    // the operator to go look at trip log. No boundary at all means trip on
    // never fired, or it is a plain shell.
    if (boundary === 0) return "unknown";
    const age = Date.now() / 1000 - boundary;
    return age <= STARTING_WINDOW_SECONDS ? "starting" : "unknown";
  }

  const last = scoped[scoped.length - 1];
  if (last.type === "agent_turn_end" || last.type === "agent_session_end")
    return "idle";

  // waiting: an unanswered trip-message-wait tool call (Claude only).
  const answered = new Set(
    scoped
      .filter((e) => e.type === "agent_tool_result")
      .map((e) => e.tool_call_id as string)
  );
  for (let i = scoped.length - 1; i >= 0; i--) {
    const e = scoped[i];
    if (e.type === "agent_turn_end") break;
    if (isMessageWaitCall(e) && !answered.has(e.id as string)) return "waiting";
  }
  return "working";
}
