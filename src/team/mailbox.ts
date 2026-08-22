import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import {
  busPath,
  tmpDir,
  inboxDir,
  workingDir,
  archiveDir,
  ensureAgentDirs,
  ensureTeamDirs,
  validId,
} from "./paths.js";
import { Draft, Message, makeMessage } from "./envelope.js";
import { resolveAddress } from "./roster.js";

/** Sender id minted only inside the library, never via the CLI. */
export const RESERVED_SENDER = "tripping";

/** One short line per event; bodies stay out of bus.jsonl. */
export function bus(team: string, record: Record<string, unknown>): void {
  ensureTeamDirs(team);
  const line = JSON.stringify({ t: Math.floor(Date.now() / 1000), ...record });
  appendFileSync(busPath(team), line + "\n");
}

export interface SendResult {
  message: Message;
  /** Set when a result send closed (or failed to close) a working/ task. */
  close?: CloseResult;
}

export interface CloseResult {
  closed?: string; // message id moved working -> archive
  warning?: string;
  inFlight?: string[]; // printed when ambiguous; nothing closed
}

/**
 * Send: stage in tmp/, rename into the recipient's inbox — atomic, so a
 * reader never sees a partial file. A result send then closes the matching
 * working/ task, deliver-then-close, so a crash between the two leaves the
 * result durable and the sweep to dedup the bookkeeping.
 */
export function send(team: string, draft: Draft): SendResult {
  const to = resolveAddress(team, draft.to);
  if (to === RESERVED_SENDER) {
    throw new Error(`'${RESERVED_SENDER}' is reserved and has no mailbox`);
  }
  if (!validId(to)) throw new Error(`invalid recipient id: ${to}`);
  if (!validId(draft.from)) throw new Error(`invalid sender id: ${draft.from}`);

  const message = makeMessage({ ...draft, to });
  ensureTeamDirs(team);
  ensureAgentDirs(team, to); // mail may queue ahead of a spawn
  const staging = join(tmpDir(team), `${message.id}.json`);
  writeFileSync(staging, JSON.stringify(message, null, 2) + "\n");
  renameSync(staging, join(inboxDir(team, to), `${message.id}.json`));
  bus(team, {
    event: "message",
    id: message.id,
    from: message.from,
    to,
    kind: message.kind,
    thread: message.thread,
  });

  let close: CloseResult | undefined;
  if (message.kind === "result" && message.from !== RESERVED_SENDER) {
    close = closeWorking(team, message.from, draft.thread);
  }
  return { message, close };
}

/** Close working/<thread>.json -> archive/ after its result was delivered. */
export function closeWorking(
  team: string,
  agent: string,
  thread?: string
): CloseResult {
  const dir = workingDir(team, agent);
  const inFlight = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    : [];
  if (inFlight.length === 0) return {};

  let file: string | undefined;
  let warning: string | undefined;
  if (thread) {
    file = inFlight.find((f) => f === `${thread}.json`);
    if (!file) return {};
  } else if (inFlight.length === 1) {
    file = inFlight[0];
    warning = `no --thread given; closed the only task in flight (${file})`;
  } else {
    return {
      warning: "no --thread given and several tasks are in flight; closed none",
      inFlight: inFlight.map((f) => f.replace(/\.json$/, "")),
    };
  }

  mkdirSync(archiveDir(team, agent), { recursive: true });
  renameSync(join(dir, file), join(archiveDir(team, agent), file));
  const id = file.replace(/\.json$/, "");
  bus(team, { event: "close", agent, id });
  return { closed: id, warning };
}

function listMessages(dir: string): Message[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort() // sortable ids: lexicographic is chronological
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Message);
}

export interface ReadResult {
  message: Message;
  disposition: "claimed" | "archived";
}

/**
 * Read: claim each kind:task by rename(inbox -> working); archive every
 * other kind — non-task mail is deliberately at-most-once.
 */
export function read(team: string, agent: string): ReadResult[] {
  ensureAgentDirs(team, agent);
  const results: ReadResult[] = [];
  for (const message of listMessages(inboxDir(team, agent))) {
    const file = `${message.id}.json`;
    const from = join(inboxDir(team, agent), file);
    if (message.kind === "task") {
      renameSync(from, join(workingDir(team, agent), file));
      bus(team, { event: "claim", agent, id: message.id, thread: message.thread });
      results.push({ message, disposition: "claimed" });
    } else {
      renameSync(from, join(archiveDir(team, agent), file));
      results.push({ message, disposition: "archived" });
    }
  }
  return results;
}

export interface PeekResult {
  unread: Message[];
  inFlight: string[];
}

/** Peek: print unread, move nothing. */
export function peek(team: string, agent: string): PeekResult {
  const working = workingDir(team, agent);
  return {
    unread: listMessages(inboxDir(team, agent)),
    inFlight: existsSync(working)
      ? readdirSync(working)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => f.replace(/\.json$/, ""))
      : [],
  };
}

/**
 * Wait: block until the inbox is non-empty. Returns immediately when it
 * already is — a respawned teammate with queued messages must unblock
 * itself, because it reads as waiting and the doorbell never rings it.
 */
export async function wait(
  team: string,
  agent: string,
  timeoutMs: number,
  pollMs = 200
): Promise<number> {
  ensureAgentDirs(team, agent);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = existsSync(inboxDir(team, agent))
      ? readdirSync(inboxDir(team, agent)).filter((f) => f.endsWith(".json"))
          .length
      : 0;
    if (count > 0) return count;
    if (Date.now() >= deadline) return 0;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
