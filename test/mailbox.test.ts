import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { newId, makeMessage } from "../src/team/envelope.js";
import { send, read, peek, wait, closeWorking, RESERVED_SENDER } from "../src/team/mailbox.js";
import { writeTeam, resolveAddress, DEFAULT_LIMITS } from "../src/team/roster.js";
import { inboxDir, workingDir, archiveDir, busPath, teamJsonPath } from "../src/team/paths.js";

const TEAM = "t";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tripping-test-"));
  process.env.TRIP_TEAMS_DIR = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.TRIP_TEAMS_DIR;
});

const busLines = () =>
  readFileSync(busPath(TEAM), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("envelope", () => {
  it("ids sort lexicographically in generation order", () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("a fresh task's thread defaults to its own id", () => {
    const m = makeMessage({ from: "a", to: "b", kind: "task", subject: "s", body: "" });
    expect(m.thread).toBe(m.id);
  });
  it("a non-task without a thread gets an empty thread", () => {
    const m = makeMessage({ from: "a", to: "b", kind: "note", subject: "s", body: "" });
    expect(m.thread).toBe("");
  });
});

describe("send", () => {
  it("lands exactly one file in the recipient's inbox, none in tmp", () => {
    const { message } = send(TEAM, { from: "w1", to: "w2", kind: "note", subject: "hi", body: "b" });
    expect(readdirSync(inboxDir(TEAM, "w2"))).toEqual([`${message.id}.json`]);
    expect(readdirSync(join(root, TEAM, "tmp"))).toEqual([]);
  });
  it("refuses the reserved sender's mailbox as recipient", () => {
    expect(() => send(TEAM, { from: "w1", to: RESERVED_SENDER, kind: "note", subject: "", body: "" }))
      .toThrow(/reserved/);
  });
  it("rejects ids with path characters", () => {
    expect(() => send(TEAM, { from: "w1", to: "../evil", kind: "note", subject: "", body: "" }))
      .toThrow(/invalid recipient/);
  });
  it("audits every message to bus.jsonl without the body", () => {
    send(TEAM, { from: "w1", to: "w2", kind: "note", subject: "s", body: "SECRETBODY" });
    const lines = busLines();
    expect(lines.some((l) => l.event === "message" && l.from === "w1")).toBe(true);
    expect(readFileSync(busPath(TEAM), "utf8")).not.toContain("SECRETBODY");
  });
  it("resolves the coordinator alias through team.json", () => {
    writeTeam(TEAM, { coordinator: "lead", limits: DEFAULT_LIMITS, agents: {} });
    const { message } = send(TEAM, { from: "w1", to: "coordinator", kind: "note", subject: "", body: "" });
    expect(message.to).toBe("lead");
    expect(existsSync(inboxDir(TEAM, "lead"))).toBe(true);
    expect(resolveAddress(TEAM, "coordinator")).toBe("lead");
  });
});

describe("read", () => {
  it("claims tasks into working/, archives everything else", () => {
    const task = send(TEAM, { from: "c", to: "w1", kind: "task", subject: "do", body: "" }).message;
    const note = send(TEAM, { from: "c", to: "w1", kind: "note", subject: "fyi", body: "" }).message;
    const results = read(TEAM, "w1");
    expect(results.map((r) => r.disposition)).toEqual(["claimed", "archived"]);
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([`${task.id}.json`]);
    expect(readdirSync(archiveDir(TEAM, "w1"))).toEqual([`${note.id}.json`]);
    expect(readdirSync(inboxDir(TEAM, "w1"))).toEqual([]);
    expect(busLines().some((l) => l.event === "claim" && l.id === task.id)).toBe(true);
  });
  it("returns messages in id (time) order", () => {
    const first = send(TEAM, { from: "c", to: "w1", kind: "note", subject: "1", body: "" }).message;
    const second = send(TEAM, { from: "c", to: "w1", kind: "note", subject: "2", body: "" }).message;
    expect(read(TEAM, "w1").map((r) => r.message.id)).toEqual([first.id, second.id]);
  });
  it("non-task mail is at-most-once: a second read sees nothing", () => {
    send(TEAM, { from: "c", to: "w1", kind: "answer", subject: "", body: "" });
    expect(read(TEAM, "w1")).toHaveLength(1);
    expect(read(TEAM, "w1")).toHaveLength(0);
  });
});

describe("result closes working", () => {
  function dispatchAndClaim(): string {
    const { message } = send(TEAM, { from: "c", to: "w1", kind: "task", subject: "do", body: "" });
    read(TEAM, "w1");
    return message.thread;
  }
  it("deliver-then-close: result lands in recipient inbox and working file archives", () => {
    const thread = dispatchAndClaim();
    const { message, close } = send(TEAM, {
      from: "w1", to: "c", kind: "result", subject: "done", body: "", thread,
    });
    expect(close?.closed).toBe(thread);
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([]);
    expect(readdirSync(archiveDir(TEAM, "w1"))).toEqual([`${thread}.json`]);
    expect(readdirSync(inboxDir(TEAM, "c"))).toEqual([`${message.id}.json`]);
    expect(busLines().some((l) => l.event === "close" && l.id === thread)).toBe(true);
  });
  it("missing --thread with one task in flight closes it with a warning", () => {
    dispatchAndClaim();
    const { close } = send(TEAM, { from: "w1", to: "c", kind: "result", subject: "", body: "" });
    expect(close?.closed).toBeTruthy();
    expect(close?.warning).toMatch(/only task in flight/);
  });
  it("missing --thread with several in flight closes none and lists them", () => {
    const t1 = dispatchAndClaim();
    const t2 = dispatchAndClaim();
    const { close } = send(TEAM, { from: "w1", to: "c", kind: "result", subject: "", body: "" });
    expect(close?.closed).toBeUndefined();
    expect(close?.inFlight).toEqual([t1, t2].sort());
    expect(readdirSync(workingDir(TEAM, "w1"))).toHaveLength(2);
  });
  it("a wrong thread closes nothing and the task stays in flight", () => {
    const thread = dispatchAndClaim();
    const { close } = send(TEAM, { from: "w1", to: "c", kind: "result", subject: "", body: "", thread: "01WRONG" });
    expect(close?.closed).toBeUndefined();
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([`${thread}.json`]);
  });
  it("a reserved-sender result never closes anything", () => {
    const thread = dispatchAndClaim();
    send(TEAM, { from: RESERVED_SENDER, to: "c", kind: "result", subject: "park", body: "", thread });
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([`${thread}.json`]);
  });
});

describe("peek and wait", () => {
  it("peek moves nothing and reports in-flight tasks", () => {
    send(TEAM, { from: "c", to: "w1", kind: "task", subject: "", body: "" });
    read(TEAM, "w1");
    send(TEAM, { from: "c", to: "w1", kind: "note", subject: "", body: "" });
    const { unread, inFlight } = peek(TEAM, "w1");
    expect(unread).toHaveLength(1);
    expect(inFlight).toHaveLength(1);
    expect(readdirSync(inboxDir(TEAM, "w1"))).toHaveLength(1);
  });
  it("wait returns immediately when the inbox is non-empty", async () => {
    send(TEAM, { from: "c", to: "w1", kind: "note", subject: "", body: "" });
    const start = Date.now();
    expect(await wait(TEAM, "w1", 5000)).toBe(1);
    expect(Date.now() - start).toBeLessThan(100);
  });
  it("wait times out at zero when nothing arrives", async () => {
    expect(await wait(TEAM, "w1", 300)).toBe(0);
  });
  it("wait picks up a message that arrives mid-wait", async () => {
    const p = wait(TEAM, "w1", 5000, 50);
    setTimeout(() => send(TEAM, { from: "c", to: "w1", kind: "note", subject: "", body: "" }), 120);
    expect(await p).toBe(1);
  });
});

describe("roster", () => {
  it("team.json round-trips through tmp+rename", () => {
    writeTeam(TEAM, { coordinator: "coordinator", limits: DEFAULT_LIMITS, agents: {} });
    expect(existsSync(teamJsonPath(TEAM))).toBe(true);
    expect(readdirSync(join(root, TEAM, "tmp"))).toEqual([]);
  });
  it("closeWorking on an empty working dir is a no-op", () => {
    expect(closeWorking(TEAM, "ghost")).toEqual({});
  });
});
