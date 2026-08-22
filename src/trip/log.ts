/**
 * Typed view of trip's per-session recording at
 * ~/.trip/sessions/<name>/log.jsonl — the normalized agent events
 * daemon/agent.rs writes for both engines, plus the raw PTY events.
 * Read directly from disk: stateless, no daemon call (§6).
 */
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Overridable for tests via TRIP_SESSIONS_DIR. */
export function sessionsRoot(): string {
  return process.env.TRIP_SESSIONS_DIR ?? join(homedir(), ".trip", "sessions");
}

export const sessionDir = (session: string) => join(sessionsRoot(), session);
export const sessionLogPath = (session: string) =>
  join(sessionDir(session), "log.jsonl");
export const agentJsonPath = (session: string) =>
  join(sessionDir(session), "agent.json");

export interface TripEvent {
  type: string;
  t: number;
  [key: string]: unknown;
}

export const AGENT_EVENT_TYPES = new Set([
  "agent_session_start",
  "agent_session_end",
  "agent_text",
  "agent_thinking",
  "agent_tool_call",
  "agent_tool_result",
  "agent_turn_end",
  "agent_activity",
]);

/** Read every event in the session log; unparseable lines are skipped. */
export function readLog(session: string): TripEvent[] {
  const path = sessionLogPath(session);
  if (!existsSync(path)) return [];
  const events: TripEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TripEvent;
      if (typeof event.type === "string") events.push(event);
    } catch {
      /* partial trailing write or corruption; skip the line */
    }
  }
  return events;
}

export interface AgentConfig {
  kind: string;
  log_path: string;
}

export function readAgentConfig(session: string): AgentConfig | null {
  try {
    return JSON.parse(
      readFileSync(agentJsonPath(session), "utf8")
    ) as AgentConfig;
  } catch {
    return null;
  }
}
