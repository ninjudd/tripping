import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, chmodSync, readdirSync, appendFileSync, cpSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { initTeam, spawnTeammate } from "../src/team/spawn.js";
import { respawnTeammate, REDELIVERY_CAP, checkpointWorktree } from "../src/team/respawn.js";
import { sweepOnce, screenParked, PARK_ESCALATE_AFTER } from "../src/team/watcher.js";
import { dispatchTasks, awaitResults, joinFailed } from "../src/team/dispatch.js";
import { readTeam, writeTeam } from "../src/team/roster.js";
import { send, read, readBus, requeueMessage, workingEntries } from "../src/team/mailbox.js";
import { inboxDir, workingDir, deadDir, archiveDir } from "../src/team/paths.js";

const TEAM = "t";
let root: string, sessions: string, stubDir: string, repo: string;
let savedPath: string, savedAgent: string | undefined;

function writeStub(): void {
  const stub = `#!/bin/sh
echo "$@" >> "${stubDir}/calls.log"
case "$1" in
  create)
    mkdir -p "${sessions}/$2"
    touch "${sessions}/$2/log.jsonl"
    printf '{"kind":"claude","log_path":"/fake"}\\n' > "${sessions}/$2/agent.json"
    echo "$2" >> "${stubDir}/live.txt" ;;
  kill)
    if grep -qx "$2" "${stubDir}/live.txt" 2>/dev/null; then
      grep -vx "$2" "${stubDir}/live.txt" > "${stubDir}/t" || true; mv "${stubDir}/t" "${stubDir}/live.txt"
    else echo "session not found" >&2; exit 1; fi ;;
  ls) cat "${stubDir}/live.txt" 2>/dev/null || true ;;
  screen) cat "${sessions}/$2/screen.txt" 2>/dev/null || true ;;
  send) echo "SEND $2 $3" >> "${stubDir}/calls.log" ;;
esac
`;
  writeFileSync(join(stubDir, "trip"), stub);
  chmodSync(join(stubDir, "trip"), 0o755);
}

const markDead = (session: string) => {
  const live = join(stubDir, "live.txt");
  if (!existsSync(live)) return;
  const rest = readFileSync(live, "utf8").split("\n").filter((l) => l && l !== session);
  writeFileSync(live, rest.join("\n") + (rest.length ? "\n" : ""));
};
const setLog = (session: string, events: object[]) => {
  mkdirSync(join(sessions, session), { recursive: true });
  writeFileSync(join(sessions, session, "log.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};
const setScreen = (session: string, text: string) => {
  mkdirSync(join(sessions, session), { recursive: true });
  writeFileSync(join(sessions, session, "screen.txt"), text);
};
const calls = () => existsSync(join(stubDir, "calls.log")) ? readFileSync(join(stubDir, "calls.log"), "utf8") : "";
/** Drop the spawn's own trip calls so an assertion can only match the respawn's. */
const clearCalls = () => writeFileSync(join(stubDir, "calls.log"), "");
const now = () => Math.floor(Date.now() / 1000);


/** A git repo costs three process spawns to create, and every test needed
 *  one: ~290 execs across the suite. Build it once per file and copy it
 *  in-process instead — three execs per file. Worth doing because an exec is
 *  not free here (a machine running endpoint scanning pays per process), but
 *  measure before blaming the suite for a slow run: it is 15s on an idle
 *  machine and 80s on a loaded one, and load has dominated every time. */
let repoTemplate: string;
function makeRepoTemplate(): void {
  repoTemplate = mkdtempSync(join(tmpdir(), "tripping-repo-template-"));
  execFileSync("git", ["init", "-q", repoTemplate]);
  writeFileSync(join(repoTemplate, "README.md"), "hi\n");
  execFileSync("git", ["-C", repoTemplate, "add", "-A"]);
  execFileSync("git", ["-C", repoTemplate, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "init"]);
}

beforeAll(makeRepoTemplate);
afterAll(() => rmSync(repoTemplate, { recursive: true, force: true }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tripping-watch-"));
  sessions = join(root, "sessions"); stubDir = join(root, "stub"); repo = join(root, "repo");
  for (const d of [sessions, stubDir]) mkdirSync(d, { recursive: true });
  cpSync(repoTemplate, repo, { recursive: true });
  process.env.TRIP_TEAMS_DIR = join(root, "teams");
  process.env.TRIP_SESSIONS_DIR = sessions;
  savedPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${savedPath}`;
  savedAgent = process.env.TRIP_AGENT;
  delete process.env.TRIP_AGENT;
  writeStub();
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedAgent === undefined) delete process.env.TRIP_AGENT; else process.env.TRIP_AGENT = savedAgent;
  delete process.env.TRIP_TEAMS_DIR; delete process.env.TRIP_SESSIONS_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function liveTeammate(id = "w1"): Promise<void> {
  initTeam(TEAM);
  await spawnTeammate(TEAM, id, { role: "r", cwd: repo });
}

describe("respawn sequence (§15)", () => {
  it("a dead session passes the guard; live-working refuses without --force", async () => {
    await liveTeammate();
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_text", t: now() + 2, text: "busy" },
    ]);
    await expect(respawnTeammate(TEAM, "w1")).rejects.toThrow(/--force.*Codex/s);
    markDead("t-w1");
    await expect(respawnTeammate(TEAM, "w1")).resolves.toBeTruthy();
  });
  it("--force overrides a live-working guard", async () => {
    await liveTeammate();
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_text", t: now() + 2, text: "busy" },
    ]);
    await expect(respawnTeammate(TEAM, "w1", { force: true })).resolves.toBeTruthy();
  });
  it("writes the restart notice and preserves identity, tier, and role", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "special role", cwd: repo, yolo: true });
    markDead("t-w1");
    clearCalls();
    await respawnTeammate(TEAM, "w1", { reason: "context degraded" });
    const row = readTeam(TEAM)!.agents["w1"];
    expect(row.spawns).toBe(2);
    expect(row.killed_at).toBeUndefined();
    const { messages } = read(TEAM, "w1");
    const notice = messages.find((m) => m.message.kind === "control");
    expect(notice?.message.from).toBe("tripping");
    expect(notice?.message.body).toContain("context degraded");
    expect(calls()).toContain("bypassPermissions"); // yolo persisted
    expect(calls()).toContain("special role"); // role prompt regenerated
  });
  it("replays model and effort on the restarted session", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", {
      role: "writer",
      cwd: repo,
      model: "opus",
      effort: "xhigh",
    });
    markDead("t-w1");
    // Without this the spawn's own create line satisfies the assertion below
    // and the test passes with the pass-through deleted.
    clearCalls();
    await respawnTeammate(TEAM, "w1");
    const row = readTeam(TEAM)!.agents["w1"];
    expect(row.model).toBe("opus");
    expect(row.effort).toBe("xhigh");
    expect(calls()).toContain("--model opus --effort xhigh");
  });
  it("re-delivers a held task with a companion note, task first", async () => {
    await liveTeammate();
    send(TEAM, { from: "coordinator", to: "w1", kind: "task", subject: "do", body: "" });
    read(TEAM, "w1"); // claim
    markDead("t-w1");
    await respawnTeammate(TEAM, "w1");
    const inbox = readdirSync(inboxDir(TEAM, "w1")).sort();
    expect(inbox.length).toBeGreaterThanOrEqual(2); // task + note + notice
    const { messages } = read(TEAM, "w1");
    expect(messages[0].message.kind).toBe("task"); // sortable ids: task first
    expect(messages.some((m) => m.message.subject.includes("re-delivered"))).toBe(true);
    expect(readBus(TEAM).some((l) => l.event === "redeliver" && l.attempt === 1)).toBe(true);
  });
  it("dedups a task whose result already reached the bus", async () => {
    await liveTeammate();
    const { message: task } = send(TEAM, { from: "coordinator", to: "w1", kind: "task", subject: "do", body: "" });
    read(TEAM, "w1");
    // the result was sent, but the crash ate the close: put the file back
    send(TEAM, { from: "w1", to: "coordinator", kind: "result", subject: "done", body: "", thread: task.thread });
    const archived = join(archiveDir(TEAM, "w1"), `${task.id}.json`);
    const working = join(workingDir(TEAM, "w1"), `${task.id}.json`);
    execFileSync("mv", [archived, working]);
    markDead("t-w1");
    await respawnTeammate(TEAM, "w1");
    expect(existsSync(archived)).toBe(true); // re-archived, not re-delivered
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([]);
  });
  it("dead-letters past the cap with a park mail that names the recovery", async () => {
    await liveTeammate();
    const { message: task } = send(TEAM, { from: "coordinator", to: "w1", kind: "task", subject: "poison", body: "" });
    for (let i = 0; i <= REDELIVERY_CAP; i++) {
      read(TEAM, "w1"); // claim (reads the note too on later rounds)
      markDead("t-w1");
      await respawnTeammate(TEAM, "w1");
    }
    expect(readdirSync(deadDir(TEAM, "w1"))).toContain(`${task.id}.json`);
    const { messages } = read(TEAM, "coordinator");
    const park = messages.find((m) => m.message.from === "tripping" && m.message.kind === "result");
    expect(park?.message.thread).toBe(task.thread);
    expect(park?.message.body).toContain(`trip team requeue w1 ${task.id}`);
  });
  it("checkpoints a dirty worktree, excluding tripping's files", async () => {
    initTeam(TEAM);
    const { worktree } = await spawnTeammate(TEAM, "w1", { role: "w", worktree: true, cwd: repo });
    writeFileSync(join(worktree!, "work.txt"), "half-done\n");
    const sha = checkpointWorktree(worktree!, "w1", 2);
    expect(sha).toBeTruthy();
    const shown = execFileSync("git", ["-C", worktree!, "show", "--stat", "--name-only", sha!], { encoding: "utf8" });
    expect(shown).toContain("work.txt");
    expect(shown).not.toContain("AGENTS.md");
    expect(shown).not.toContain(".tripping");
  });
  it("checkpoints an edit to the repo's own AGENTS.md — only tripping's is excluded", async () => {
    // §15 step 4's qualifier: excluded "when tripping wrote them". A tracked
    // AGENTS.md is the repo's, and editing it may be the teammate's whole task.
    writeFileSync(join(repo, "AGENTS.md"), "the repo's own contract\n");
    execFileSync("git", ["-C", repo, "add", "AGENTS.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-qm", "ship AGENTS.md"]);
    initTeam(TEAM);
    const { worktree } = await spawnTeammate(TEAM, "w1", { role: "w", worktree: true, cwd: repo });
    writeFileSync(join(worktree!, "AGENTS.md"), "the repo's own contract, amended\n");
    writeFileSync(join(worktree!, "CLAUDE.md"), "tripping wrote this one\n");
    const sha = checkpointWorktree(worktree!, "w1", 2);
    expect(sha).toBeTruthy();
    const shown = execFileSync("git", ["-C", worktree!, "show", "--stat", "--name-only", sha!], { encoding: "utf8" });
    expect(shown).toContain("AGENTS.md");
    expect(shown).not.toContain("CLAUDE.md");
  });
});

describe("watcher sweep (§12/§8)", () => {
  it("respawns a dead teammate and increments the breaker", async () => {
    await liveTeammate();
    markDead("t-w1");
    const actions = await sweepOnce(TEAM);
    expect(actions.join()).toContain("respawned");
    expect(readTeam(TEAM)!.agents["w1"].restarts_since_human).toBe(1);
  });
  it("breaker at the cap: leaves it down, notes the coordinator once", async () => {
    await liveTeammate();
    const roster = readTeam(TEAM)!;
    roster.agents["w1"].restarts_since_human = roster.limits.max_respawns;
    writeTeam(TEAM, roster);
    markDead("t-w1");
    expect((await sweepOnce(TEAM)).join()).toContain("breaker tripped");
    const before = readdirSync(inboxDir(TEAM, "coordinator")).length;
    await sweepOnce(TEAM); // second pass: no new note
    expect(readdirSync(inboxDir(TEAM, "coordinator")).length).toBe(before);
  });
  it("breaker at the cap: held tasks dead-letter so the join fails fast", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    const [task] = dispatchTasks(TEAM, "coordinator", [
      { to: "w1", subject: "held", body: "" },
    ]);
    read(TEAM, "w1"); // claimed into working/
    const roster = readTeam(TEAM)!;
    roster.agents["w1"].restarts_since_human = roster.limits.max_respawns;
    writeTeam(TEAM, roster);
    markDead("t-w1");

    expect((await sweepOnce(TEAM)).join()).toContain("dead-lettered");
    expect(workingEntries(TEAM, "w1")).toHaveLength(0);
    expect(readdirSync(deadDir(TEAM, "w1"))).toHaveLength(1);
    expect(readBus(TEAM).some((l) => l.event === "dead_letter")).toBe(true);

    // The point of the park mail: it rides the task's own thread, so the
    // join returns failure instead of running out an hour-long timeout.
    const { done, pending } = await awaitResults(TEAM, [task], {
      timeoutMs: 3000,
      pollMs: 100,
    });
    expect(pending).toHaveLength(0);
    expect(done.filter(joinFailed)).toHaveLength(1);

    await sweepOnce(TEAM); // idempotent: working/ is already empty
    expect(readdirSync(deadDir(TEAM, "w1"))).toHaveLength(1);
  });
  it("a respawn survives another teammate's flag write in the same sweep", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "a", { role: "r", cwd: repo });
    await spawnTeammate(TEAM, "b", { role: "r", cwd: repo });
    // a is dead and will be respawned; b is alive, idle, parked, and holding
    // mail, so its park_noted write fires later in the same loop.
    markDead("t-a");
    setLog("t-b", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_turn_end", t: now() + 2 },
    ]);
    setScreen("t-b", "Do you want to proceed?\n❯ 1. Yes\n  2. No");
    send(TEAM, { from: "coordinator", to: "b", kind: "note", subject: "hi", body: "" });
    const beforeSpawnedAt = readTeam(TEAM)!.agents["a"].spawned_at;

    const actions = await sweepOnce(TEAM);
    expect(actions.join()).toContain("a: dead session — respawned");
    expect(actions.join()).toContain("b: parked");

    const a = readTeam(TEAM)!.agents["a"];
    expect(a.spawned_at).not.toBe(beforeSpawnedAt); // the respawn's value stands
    expect(a.spawns).toBe(2);
    expect(a.restarts_since_human).toBe(1);
    expect(readTeam(TEAM)!.agents["b"].park_noted).toBe(true);
  });
  it("a result after the respawn resets the breaker", async () => {
    await liveTeammate();
    const roster = readTeam(TEAM)!;
    roster.agents["w1"].restarts_since_human = 2;
    writeTeam(TEAM, roster);
    send(TEAM, { from: "w1", to: "coordinator", kind: "result", subject: "healthy", body: "" });
    await sweepOnce(TEAM);
    expect(readTeam(TEAM)!.agents["w1"].restarts_since_human).toBe(0);
  });
  it("rings the doorbell only at an idle teammate with mail", async () => {
    await liveTeammate();
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_turn_end", t: now() + 2 },
    ]);
    send(TEAM, { from: "coordinator", to: "w1", kind: "note", subject: "hi", body: "" });
    await sweepOnce(TEAM);
    expect(calls()).toContain("SEND t-w1 New message. Run: trip message read");
  });
  it("never types into a parked prompt; notes the coordinator once per park", async () => {
    await liveTeammate();
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_turn_end", t: now() + 2 },
    ]);
    setScreen("t-w1", "Do you want to allow Bash to run rm -rf?\n❯ 1. Yes\n  2. No");
    send(TEAM, { from: "coordinator", to: "w1", kind: "note", subject: "hi", body: "" });
    await sweepOnce(TEAM);
    expect(calls()).not.toContain("SEND t-w1 New message");
    expect(readTeam(TEAM)!.agents["w1"].park_noted).toBe(true);
    const notes = read(TEAM, "coordinator").messages.filter((m) => m.message.subject.includes("parked"));
    expect(notes).toHaveLength(1);
    await sweepOnce(TEAM); // suppressed, audited, not re-mailed
    expect(readBus(TEAM).some((l) => l.event === "doorbell_suppressed")).toBe(true);
    setScreen("t-w1", "$ "); // prompt answered
    await sweepOnce(TEAM);
    expect(readTeam(TEAM)!.agents["w1"].park_noted).toBeUndefined();
    expect(calls()).toContain("SEND t-w1 New message");
  });
  it("escalates a park that has swallowed too many doorbells", async () => {
    await liveTeammate();
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_turn_end", t: now() + 2 },
    ]);
    setScreen("t-w1", "Do you want to proceed?\n❯ 1. Yes\n  2. No");
    send(TEAM, { from: "coordinator", to: "w1", kind: "note", subject: "hi", body: "" });
    for (let i = 0; i <= PARK_ESCALATE_AFTER; i++) await sweepOnce(TEAM);
    const notes = read(TEAM, "coordinator").messages.map((m) => m.message.subject);
    expect(notes.filter((s) => s.includes("parked at a permission prompt"))).toHaveLength(1);
    expect(notes.filter((s) => s.includes("mail is stranded"))).toHaveLength(1);
    expect(readTeam(TEAM)!.agents["w1"].park_escalated).toBe(true);
  });
  it("nudges an idle teammate holding a task — never reclaims", async () => {
    await liveTeammate();
    const { message: task } = send(TEAM, { from: "coordinator", to: "w1", kind: "task", subject: "do", body: "" });
    read(TEAM, "w1");
    setLog("t-w1", [
      { type: "agent_session_start", t: now() + 1, continuation: "x" },
      { type: "agent_turn_end", t: now() + 2 },
    ]);
    await sweepOnce(TEAM);
    expect(calls()).toContain(`You still hold task ${task.id}`);
    expect(readdirSync(workingDir(TEAM, "w1"))).toEqual([`${task.id}.json`]);
  });
});

describe("dispatch --wait (§4/§15)", () => {
  it("joins on results, park mail counted as failure", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "a", { role: "r", cwd: repo });
    await spawnTeammate(TEAM, "b", { role: "r", cwd: repo });
    const outcomes = dispatchTasks(TEAM, "coordinator", [
      { to: "a", subject: "one", body: "" },
      { to: "b", subject: "two", body: "" },
    ]);
    // a finishes; b's task gets dead-lettered via park mail
    read(TEAM, "a");
    send(TEAM, { from: "a", to: "coordinator", kind: "result", subject: "done", body: "", thread: outcomes[0].thread });
    send(TEAM, { from: "tripping", to: "coordinator", kind: "result", subject: "task failed", body: "", thread: outcomes[1].thread });
    const { done, pending } = await awaitResults(TEAM, outcomes, { timeoutMs: 3000, pollMs: 100 });
    expect(pending).toHaveLength(0);
    expect(done.filter(joinFailed).map((o) => o.subject)).toEqual(["two"]);
  });
  it("times out listing what is missing", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "a", { role: "r", cwd: repo });
    const outcomes = dispatchTasks(TEAM, "coordinator", [{ to: "a", subject: "slow", body: "" }]);
    const { pending } = await awaitResults(TEAM, outcomes, { timeoutMs: 400, pollMs: 100 });
    expect(pending).toHaveLength(1);
  });
});

describe("requeue", () => {
  it("revives a dead-lettered task with the audit line and note", async () => {
    await liveTeammate();
    const { message: task } = send(TEAM, { from: "coordinator", to: "w1", kind: "task", subject: "p", body: "" });
    read(TEAM, "w1");
    mkdirSync(deadDir(TEAM, "w1"), { recursive: true });
    execFileSync("mv", [join(workingDir(TEAM, "w1"), `${task.id}.json`), join(deadDir(TEAM, "w1"), `${task.id}.json`)]);
    expect(requeueMessage(TEAM, "w1", task.id)).toBe("dead");
    expect(readdirSync(inboxDir(TEAM, "w1"))).toContain(`${task.id}.json`);
    expect(readBus(TEAM).some((l) => l.event === "requeue")).toBe(true);
  });
});

describe("screen guard", () => {
  it("reads a real prompt as parked", () => {
    for (const text of [
      "Do you want to proceed?\n❯ 1. Yes\n  2. No",
      "Allow Bash to run this?\n❯ 1. Yes\n  2. No, tell Claude what to do",
      "Approve this action?\n❯ 1. Yes\n  2. No",
      "continue? y/n",
      "Yes, and don't ask again for rm in this project",
      "Apply this patch? [y/N]",
    ]) {
      setScreen("t-x", text);
      expect(screenParked("t-x"), text).toBe(true);
    }
  });
  it("does not read ordinary agent output as parked", () => {
    // Prose about approving is what teammates write all day; a false positive
    // here strands the mail permanently, because an idle screen never changes.
    for (const text of [
      "$ npm test\nall passing",
      "I reviewed the PR and left a comment asking them to approve the change.",
      "Done. The CI job will allow deploys to production once green.",
      "Summary: 3 files changed. Next: ask the reviewer to approve.",
      '> git commit -m "allow admins to bypass the cache"',
    ]) {
      setScreen("t-x", text);
      expect(screenParked("t-x"), text).toBe(false);
    }
  });
  it("reads only the tail — the same words in scrollback are not a prompt", () => {
    const scrollback = Array.from(
      { length: 30 },
      (_, i) => `line ${i}: nothing to see`
    );
    setScreen("t-x", ["Do you want to proceed?", ...scrollback].join("\n"));
    expect(screenParked("t-x")).toBe(false);
  });
});
