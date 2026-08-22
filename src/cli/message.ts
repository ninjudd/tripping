#!/usr/bin/env node
/**
 * trip-message — the message verbs, dispatched as `trip message <verb>`.
 * Also installed as trip-msg. Identity comes from TRIP_TEAM / TRIP_AGENT;
 * there is no --from flag anywhere.
 */
import { KINDS, Kind } from "../team/envelope.js";
import {
  RESERVED_SENDER,
  read,
  peek,
  send,
  wait,
} from "../team/mailbox.js";
import { Message } from "../team/envelope.js";

function fail(message: string): never {
  process.stderr.write(`trip message: ${message}\n`);
  process.exit(2);
}

function identity(): { team: string; agent: string } {
  const team = process.env.TRIP_TEAM;
  const agent = process.env.TRIP_AGENT;
  if (!team) fail("TRIP_TEAM is not set. Run this inside a team session, or: trip team start <name>");
  if (!agent) fail("TRIP_AGENT is not set. Run this inside a team session.");
  if (agent === RESERVED_SENDER)
    fail(`'${RESERVED_SENDER}' is a reserved sender and cannot use the CLI`);
  if (!/^[A-Za-z0-9_-]+$/.test(team))
    fail(`TRIP_TEAM '${team}' is not a valid team id (letters, digits, - and _ only)`);
  if (!/^[A-Za-z0-9_-]+$/.test(agent))
    fail(`TRIP_AGENT '${agent}' is not a valid agent id (letters, digits, - and _ only)`);
  return { team, agent };
}

interface Flags {
  positional: string[];
  [flag: string]: string | string[] | boolean | undefined;
}

function parseFlags(argv: string[], takesValue: Set<string>): Flags {
  const out: Flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!takesValue.has(name)) fail(`unknown flag --${name}`);
    const value = argv[++i];
    if (value === undefined) fail(`--${name} needs a value`);
    if (name === "artifact") {
      out.artifact = [...((out.artifact as string[]) ?? []), value];
    } else {
      out[name] = value;
    }
  }
  return out;
}

function show(message: Message, note?: string): void {
  const head = [
    `── ${message.id}`,
    `from ${message.from}`,
    `kind ${message.kind}`,
    message.thread ? `thread ${message.thread}` : "",
    note ? `[${note}]` : "",
  ]
    .filter(Boolean)
    .join("  ");
  const artifacts = message.artifacts?.length
    ? `\n   artifacts: ${message.artifacts.join(", ")}`
    : "";
  process.stdout.write(
    `${head}\n   subject: ${message.subject}${artifacts}\n${message.body}\n`
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const { team, agent } = identity();

  switch (verb) {
    case "send": {
      const flags = parseFlags(rest, new Set(["subject", "kind", "thread", "reply-to", "artifact"]));
      const to = flags.positional[0];
      if (!to) fail("usage: trip message send <to> --subject <s> [--kind k] [--thread t]  (body on stdin)");
      const kind = (flags.kind as string) ?? "note";
      if (!KINDS.includes(kind as Kind)) fail(`unknown kind '${kind}' (one of: ${KINDS.join(", ")})`);
      if (flags.subject === undefined) fail("--subject is required");
      const body = await readStdin();
      const { message, close, unknownRecipient } = send(team, {
        from: agent,
        to,
        kind: kind as Kind,
        subject: (flags.subject as string) ?? "",
        body,
        thread: flags.thread as string | undefined,
        reply_to: flags["reply-to"] as string | undefined,
        artifacts: flags.artifact as string[] | undefined,
      });
      process.stdout.write(`sent ${message.id} to ${message.to} (${message.kind}, thread ${message.thread})\n`);
      if (unknownRecipient)
        process.stderr.write(
          `warning: '${message.to}' is not on the roster; the message will wait in their inbox\n`
        );
      if (close?.closed) process.stdout.write(`closed task ${close.closed}\n`);
      if (close?.warning) process.stderr.write(`warning: ${close.warning}\n`);
      if (close?.inFlight) process.stdout.write(`in flight: ${close.inFlight.join(", ")}\n`);
      return;
    }
    case "read": {
      parseFlags(rest, new Set());
      const { messages, quarantined } = read(team, agent);
      if (quarantined.length > 0)
        process.stderr.write(
          `warning: quarantined ${quarantined.length} unreadable file(s) to dead/: ${quarantined.join(", ")} — inspect with cat\n`
        );
      if (messages.length === 0) {
        process.stdout.write("no new messages\n");
        return;
      }
      for (const { message, disposition } of messages) {
        show(message, disposition === "claimed" ? "claimed → working" : undefined);
      }
      return;
    }
    case "peek": {
      parseFlags(rest, new Set());
      const { unread, inFlight, unreadable } = peek(team, agent);
      if (unreadable.length > 0)
        process.stderr.write(`warning: ${unreadable.length} unreadable file(s) in inbox: ${unreadable.join(", ")}\n`);
      if (unread.length === 0) process.stdout.write("no new messages\n");
      for (const message of unread) show(message);
      if (inFlight.length > 0)
        process.stdout.write(`${inFlight.length} task(s) in flight: ${inFlight.join(", ")}\n`);
      return;
    }
    case "wait": {
      const flags = parseFlags(rest, new Set(["timeout"]));
      const timeout = Number((flags.timeout as string) ?? "550");
      if (!Number.isFinite(timeout) || timeout <= 0) fail("--timeout must be a positive number of seconds");
      const count = await wait(team, agent, timeout * 1000);
      if (count > 0) {
        process.stdout.write(`${count} message(s) waiting — run: trip message read\n`);
        return;
      }
      process.stdout.write(`no messages after ${timeout}s — run: trip message wait\n`);
      process.exit(1);
    }
    default:
      fail("usage: trip message <send|read|peek|wait>");
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
