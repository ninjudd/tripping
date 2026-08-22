/**
 * Status derivation (§6): read the tail of the session's log.jsonl on
 * demand. Stateless — no status file to go stale. Events are scoped to
 * after max(last agent_session_start, roster spawned_at), because the log
 * outlives the session and a respawn must not read its predecessor's tail.
 */
import { readLog, AGENT_EVENT_TYPES, TripEvent } from "../trip/log.js";
import { readTeam } from "./roster.js";

export type Status = "idle" | "starting" | "working" | "waiting" | "unknown";

export function sessionName(team: string, id: string): string {
  return `${team}-${id}`;
}

/** The one per-engine branch (§6): a shell tool call whose input runs
 *  `trip message wait`. The tool name is Bash for Claude with the command
 *  in input; Codex records shell as custom_tool_call, which trip's parser
 *  currently drops, so waiting is derivable for Claude only. */
function isMessageWaitCall(event: TripEvent): boolean {
  if (event.type !== "agent_tool_call") return false;
  const input = JSON.stringify(event.input ?? "");
  return input.includes("trip message wait") || input.includes("trip-message wait");
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
    // Nothing after the boundary: a respawn window derives as starting;
    // no boundary at all means trip on never fired, or it is a plain shell.
    return boundary > 0 ? "starting" : "unknown";
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
