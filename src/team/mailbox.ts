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
  deadDir,
  ensureAgentDirs,
  ensureTeamDirs,
  validId,
} from "./paths.js";
import { Draft, Message, makeMessage } from "./envelope.js";
import { readTeam, resolveAddress } from "./roster.js";

/** Sender id minted only inside the library, never via the CLI. */
export const RESERVED_SENDER = "tripping";

export interface BusLine {
  t: number;
  event: string;
  [key: string]: unknown;
}

/** Parse bus.jsonl tolerantly: the audit must survive a torn tail line. */
export function readBus(team: string): BusLine[] {
  if (!existsSync(busPath(team))) return [];
  const lines: BusLine[] = [];
  for (const line of readFileSync(busPath(team), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as BusLine);
    } catch {
      /* torn write; skip */
    }
  }
  return lines;
}

/** One short line per event; bodies stay out of bus.jsonl. */
export function bus(team: string, record: Record<string, unknown>): void {
  ensureTeamDirs(team);
  const line = JSON.stringify({ t: Math.floor(Date.now() / 1000), ...record });
  appendFileSync(busPath(team), line + "\n");
}

function assertAgent(id: string, what: string): void {
  if (!validId(id)) throw new Error(`invalid ${what} id: ${id}`);
}

interface Entry {
  file: string;
  message: Message;
}

/**
 * List a maildir directory: parseable messages in filename (time) order,
 * plus the names of files that would not parse — one poison file must
 * never brick the mailbox.
 */
function listEntries(dir: string): { entries: Entry[]; poison: string[] } {
  const entries: Entry[] = [];
  const poison: string[] = [];
  if (!existsSync(dir)) return { entries, poison };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      entries.push({
        file,
        message: JSON.parse(readFileSync(join(dir, file), "utf8")) as Message,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // raced
      poison.push(file);
    }
  }
  return { entries, poison };
}

export interface SendResult {
  message: Message;
  /** Set when a result send closed (or failed to close) a working/ task. */
  close?: CloseResult;
  /** The roster exists and does not know this recipient — likely a typo. */
  unknownRecipient?: boolean;
}

export interface CloseResult {
  closed?: string; // task file id moved working -> archive
  warning?: string;
  inFlight?: string[]; // printed when nothing was closed but tasks are held
}

/**
 * Send: stage in tmp/, rename into the recipient's inbox — atomic, so a
 * reader never sees a partial file. A result send then closes the matching
 * working/ task, deliver-then-close, so a crash between the two leaves the
 * result durable and the sweep to dedup the bookkeeping. A result with no
 * --thread and exactly one task in flight inherits that task's thread
 * before delivery, so the envelope and the close never disagree.
 */
export function send(team: string, draft: Draft): SendResult {
  const to = resolveAddress(team, draft.to);
  if (to === RESERVED_SENDER) {
    throw new Error(`'${RESERVED_SENDER}' is reserved and has no mailbox`);
  }
  assertAgent(to, "recipient");
  assertAgent(draft.from, "sender");

  const closing = draft.kind === "result" && draft.from !== RESERVED_SENDER;
  let thread = draft.thread;
  let autoResolved: string | undefined;
  if (closing && !thread) {
    const { entries } = listEntries(workingDir(team, draft.from));
    if (entries.length === 1) {
      thread = entries[0].message.thread;
      autoResolved = entries[0].file.replace(/\.json$/, "");
    } else if (entries.length > 1) {
      // A result carrying thread "" is one nothing can ever correlate.
      // Refuse before delivery; the agent re-sends with the thread.
      const ids = entries.map((e) => e.file.replace(/\.json$/, ""));
      throw new Error(
        `a result needs --thread when several tasks are in flight; in flight: ${ids.join(", ")}`
      );
    }
  }

  const message = makeMessage({ ...draft, to, thread });
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
  if (closing) {
    close = closeWorking(team, draft.from, thread);
    if (close.closed && autoResolved) {
      close.warning = `no --thread given; closed the only task in flight (${close.closed})`;
    }
  }

  // Mail queues ahead of a spawn, so an unknown recipient still gets a
  // mailbox — but when a roster exists and does not know the id, say so:
  // a typo'd recipient is the likeliest way a message goes missing.
  const roster = readTeam(team);
  const unknownRecipient =
    roster !== null && to !== roster.coordinator && !(to in roster.agents);
  return { message, close, ...(unknownRecipient ? { unknownRecipient } : {}) };
}

/**
 * Close a working/ task after its result was delivered. Matched by the
 * envelope's thread — the filename is the task's id, which equals the
 * thread only for a fresh task.
 */
export function closeWorking(
  team: string,
  agent: string,
  thread?: string
): CloseResult {
  assertAgent(agent, "agent");
  const dir = workingDir(team, agent);
  const { entries } = listEntries(dir);
  if (entries.length === 0) return {};
  const ids = entries.map((e) => e.file.replace(/\.json$/, ""));

  let target: Entry | undefined;
  let warning: string | undefined;
  if (thread) {
    // Matched by envelope thread only — the filename is the task's id, which
    // equals the thread just for fresh tasks, and a filename fallback can
    // shadow a genuine thread match and close the wrong task. Oldest match
    // wins when several tasks share a thread.
    target = entries.find((e) => e.message.thread === thread);
    if (!target) {
      return {
        warning: `--thread ${thread} matches no task in flight; closed none`,
        inFlight: ids,
      };
    }
  } else if (entries.length === 1) {
    target = entries[0];
    warning = `no --thread given; closed the only task in flight (${ids[0]})`;
  } else {
    return {
      warning: "no --thread given and several tasks are in flight; closed none",
      inFlight: ids,
    };
  }

  mkdirSync(archiveDir(team, agent), { recursive: true });
  renameSync(join(dir, target.file), join(archiveDir(team, agent), target.file));
  const id = target.file.replace(/\.json$/, "");
  bus(team, { event: "close", agent, id, thread: target.message.thread });
  return { closed: id, warning };
}

/** The tasks an agent currently holds, oldest first. */
export function workingEntries(
  team: string,
  agent: string
): { file: string; message: Message }[] {
  return listEntries(workingDir(team, agent)).entries;
}

/** Revive a parked or held task: rename working|dead -> inbox, with the
 *  audit line and a companion note so the reader knows why it is back. */
export function requeueMessage(
  team: string,
  agent: string,
  msgId: string
): "working" | "dead" {
  const file = `${msgId}.json`;
  for (const [source, dir] of [
    ["working", workingDir(team, agent)],
    ["dead", deadDir(team, agent)],
  ] as const) {
    if (existsSync(join(dir, file))) {
      renameSync(join(dir, file), join(inboxDir(team, agent), file));
      bus(team, { event: "requeue", agent, id: msgId, from_dir: source });
      send(team, {
        from: RESERVED_SENDER,
        to: agent,
        kind: "note",
        subject: `task ${msgId} re-queued from ${source}/`,
        body: `A human or the coordinator revived this task. Check git log before redoing work.`,
        thread: msgId,
      });
      return source;
    }
  }
  throw new Error(
    `${msgId} is in neither working/ nor dead/ for '${agent}'`
  );
}

export interface ReadResult {
  messages: { message: Message; disposition: "claimed" | "archived" }[];
  /** Unparseable inbox files, moved to dead/ for a human to inspect. */
  quarantined: string[];
}

/**
 * Read: claim each kind:task by rename(inbox -> working); archive every
 * other kind — non-task mail is deliberately at-most-once. A file another
 * process claimed between listing and rename is skipped, not fatal.
 */
export function read(team: string, agent: string): ReadResult {
  assertAgent(agent, "agent");
  ensureAgentDirs(team, agent);
  const inbox = inboxDir(team, agent);
  const { entries, poison } = listEntries(inbox);

  const quarantined: string[] = [];
  for (const file of poison) {
    try {
      renameSync(join(inbox, file), join(deadDir(team, agent), file));
      bus(team, { event: "quarantine", agent, file });
      quarantined.push(file);
    } catch {
      /* raced away; nothing to do */
    }
  }

  const messages: ReadResult["messages"] = [];
  for (const { file, message } of entries) {
    const from = join(inbox, file);
    try {
      if (message.kind === "task") {
        renameSync(from, join(workingDir(team, agent), file));
        bus(team, { event: "claim", agent, id: message.id, thread: message.thread });
        messages.push({ message, disposition: "claimed" });
      } else {
        renameSync(from, join(archiveDir(team, agent), file));
        messages.push({ message, disposition: "archived" });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // raced
      throw err;
    }
  }
  return { messages, quarantined };
}

export interface PeekResult {
  unread: Message[];
  inFlight: string[];
  /** Unparseable inbox files; peek moves nothing, so they stay put. */
  unreadable: string[];
}

/** Peek: print unread, move nothing. */
export function peek(team: string, agent: string): PeekResult {
  assertAgent(agent, "agent");
  const { entries, poison } = listEntries(inboxDir(team, agent));
  const working = listEntries(workingDir(team, agent));
  return {
    unread: entries.map((e) => e.message),
    inFlight: working.entries.map((e) => e.file.replace(/\.json$/, "")),
    unreadable: poison,
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
  assertAgent(agent, "agent");
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
