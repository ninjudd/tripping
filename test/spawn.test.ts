import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, chmodSync, lstatSync, appendFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  initTeam, checkSpawn, spawnTeammate, killTeammate, engineCommand,
  verifyAgentRegistration,
} from "../src/team/spawn.js";
import { readTeam, writeTeam, DEFAULT_LIMITS } from "../src/team/roster.js";
import { deriveStatus } from "../src/team/status.js";
import { protocolPath } from "../src/team/protocol.js";
import { teamDir } from "../src/team/paths.js";

const TEAM = "t";
let root: string;
let sessions: string;
let stubDir: string;
let repo: string;
let savedPath: string;
let savedAgent: string | undefined;

function writeStub(kind = "claude"): void {
  const stub = `#!/bin/sh
echo "$@" >> "${stubDir}/calls.log"
case "$1" in
  create)
    mkdir -p "${sessions}/$2"
    : > "${sessions}/$2/log.jsonl"
    printf '{"kind":"${kind}","log_path":"/fake/transcript.jsonl"}\\n' > "${sessions}/$2/agent.json"
    env | grep -E '^TRIP_(TEAM|AGENT)=' >> "${stubDir}/calls.log"
    ;;
  kill)
    if [ -d "${sessions}/$2" ]; then rm -rf "${sessions}/$2"; else echo "session not found" >&2; exit 1; fi
    ;;
esac
`;
  writeFileSync(join(stubDir, "trip"), stub);
  chmodSync(join(stubDir, "trip"), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tripping-spawn-"));
  sessions = join(root, "sessions");
  stubDir = join(root, "stub");
  repo = join(root, "repo");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "hi\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  process.env.TRIP_TEAMS_DIR = join(root, "teams");
  process.env.TRIP_SESSIONS_DIR = sessions;
  savedPath = process.env.PATH!;
  process.env.PATH = `${stubDir}:${savedPath}`;
  savedAgent = process.env.TRIP_AGENT;
  delete process.env.TRIP_AGENT; // default caller: a human shell
  writeStub();
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedAgent === undefined) delete process.env.TRIP_AGENT;
  else process.env.TRIP_AGENT = savedAgent;
  delete process.env.TRIP_TEAMS_DIR;
  delete process.env.TRIP_SESSIONS_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("engineCommand (§9 tiers)", () => {
  it("auto tier", () => {
    expect(engineCommand("claude", false, "p")).toEqual(["claude", "--permission-mode", "auto", "p"]);
    expect(engineCommand("codex", false, "p")).toEqual(["codex", "--approve-for-me", "p"]);
  });
  it("yolo tier", () => {
    expect(engineCommand("claude", true, "p")).toEqual(["claude", "--permission-mode", "bypassPermissions", "p"]);
    expect(engineCommand("codex", true, "p")).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "p"]);
  });
});

describe("init and step-0 checks (§16)", () => {
  it("init writes team.json with defaults and the canonical PROTOCOL.md", () => {
    initTeam(TEAM);
    const roster = readTeam(TEAM)!;
    expect(roster.limits).toEqual(DEFAULT_LIMITS);
    expect(roster.coordinator).toBe("coordinator");
    expect(existsSync(protocolPath(TEAM))).toBe(true);
    expect(readFileSync(protocolPath(TEAM), "utf8")).toContain("trip message wait");
  });
  it("refuses without team.json, naming the recovery", () => {
    expect(() => checkSpawn(TEAM, "w1")).toThrow(/trip team init/);
  });
  it("refuses a teammate caller, naming the escalation", () => {
    initTeam(TEAM);
    process.env.TRIP_AGENT = "w1";
    expect(() => checkSpawn(TEAM, "w2")).toThrow(/--kind question/);
  });
  it("allows the coordinator caller", () => {
    initTeam(TEAM);
    process.env.TRIP_AGENT = "coordinator";
    expect(() => checkSpawn(TEAM, "w1")).not.toThrow();
  });
  it("refuses at the cap, coordinator excluded", () => {
    const roster = initTeam(TEAM);
    roster.agents["coordinator"] = { role: "c", engine: "claude", session: "t-coordinator", cwd: "/" };
    for (let i = 0; i < DEFAULT_LIMITS.max_agents; i++) {
      roster.agents[`w${i}`] = { role: "r", engine: "claude", session: `t-w${i}`, cwd: "/" };
    }
    writeTeam(TEAM, roster);
    expect(() => checkSpawn(TEAM, "extra")).toThrow(/4\/4 teammates live/);
  });
  it("a killed teammate frees its slot; a live one refuses respawn without kill", () => {
    const roster = initTeam(TEAM);
    roster.agents["w1"] = { role: "r", engine: "claude", session: "t-w1", cwd: "/" };
    writeTeam(TEAM, roster);
    expect(() => checkSpawn(TEAM, "w1")).toThrow(/kill first|already live/);
    roster.agents["w1"].killed_at = new Date().toISOString();
    writeTeam(TEAM, roster);
    expect(() => checkSpawn(TEAM, "w1")).not.toThrow();
  });
  it("reserved ids are refused for teammate spawns", () => {
    initTeam(TEAM);
    expect(() => checkSpawn(TEAM, "tripping")).toThrow(/reserved/);
    expect(() => checkSpawn(TEAM, "coordinator")).toThrow(/reserved/);
  });
  it("the roster's actual coordinator id is refused too, whatever it is", () => {
    initTeam("t2", { coordinator: "lead" });
    process.env.TRIP_TEAMS_DIR = process.env.TRIP_TEAMS_DIR; // same root
    expect(() => checkSpawn("t2", "lead")).toThrow(/reserved/);
  });
  it("team start's coordinator spawn passes the gate the alias refuses", () => {
    initTeam(TEAM);
    expect(() => checkSpawn(TEAM, "coordinator", true)).not.toThrow();
    expect(() => checkSpawn(TEAM, "someone-else", true)).toThrow(/coordinator's id/);
  });
  it("the coordinator spawn is exempt from the teammate cap", () => {
    const roster = initTeam(TEAM);
    for (let i = 0; i < DEFAULT_LIMITS.max_agents; i++) {
      roster.agents[`w${i}`] = { role: "r", engine: "claude", session: `t-w${i}`, cwd: "/" };
    }
    writeTeam(TEAM, roster);
    expect(() => checkSpawn(TEAM, "coordinator", true)).not.toThrow();
  });
});

describe("spawnTeammate (§7)", () => {
  it("creates the session with the right command, env, and roster row", async () => {
    initTeam(TEAM);
    const result = await spawnTeammate(TEAM, "w1", { role: "fix bugs", cwd: repo });
    const calls = readFileSync(join(stubDir, "calls.log"), "utf8");
    expect(calls).toContain(`create ${TEAM}-w1 -- claude --permission-mode auto`);
    expect(calls).toContain("TRIP_TEAM=t");
    expect(calls).toContain("TRIP_AGENT=w1");
    const row = readTeam(TEAM)!.agents["w1"];
    expect(row.engine).toBe("claude");
    expect(row.spawned_at).toBeTruthy();
    expect(row.spawns).toBe(1);
    expect(result.session).toBe("t-w1");
  });
  it("writer roles get a worktree, branch, contract copy, and AGENTS.md", async () => {
    initTeam(TEAM);
    const { worktree, branch, cwd } = await spawnTeammate(TEAM, "w1", {
      role: "write code", worktree: true, cwd: repo,
    });
    expect(worktree).toBe(join(teamDir(TEAM), "wt", "w1"));
    expect(branch).toBe("team/t/w1");
    expect(cwd).toBe(worktree);
    expect(existsSync(join(worktree!, ".tripping", "PROTOCOL.md"))).toBe(true);
    expect(existsSync(join(worktree!, "AGENTS.md"))).toBe(true);
    expect(lstatSync(join(worktree!, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "team/t/w1"], { encoding: "utf8" });
    expect(branches).toContain("team/t/w1");
  });
  it("repairs a wrong agent.json kind by remove-then-write", async () => {
    initTeam(TEAM);
    writeStub("codex"); // trip on's hook path hardcodes codex
    await spawnTeammate(TEAM, "w1", { role: "r", engine: "claude", cwd: repo });
    const config = JSON.parse(readFileSync(join(sessions, "t-w1", "agent.json"), "utf8"));
    expect(config.kind).toBe("claude");
    expect(config.log_path).toBe("/fake/transcript.jsonl"); // hook path kept
  });
  it("fails loudly when agent.json never appears", async () => {
    initTeam(TEAM);
    // stub that creates the session but never writes agent.json
    writeFileSync(join(stubDir, "trip"), `#!/bin/sh\nmkdir -p "${sessions}/$2"\n`);
    chmodSync(join(stubDir, "trip"), 0o755);
    await expect(
      spawnTeammate(TEAM, "w1", { role: "r", cwd: repo, registrationTimeoutMs: 1000 })
    ).rejects.toThrow(/trip on did not fire/);
  });
});

describe("kill (§16)", () => {
  it("kills the session then stamps killed_at; rerun tolerates a dead name", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    killTeammate(TEAM, "w1");
    expect(readTeam(TEAM)!.agents["w1"].killed_at).toBeTruthy();
    killTeammate(TEAM, "w1"); // stub kill now errors; stamping is the recovery
    expect(readTeam(TEAM)!.agents["w1"].killed_at).toBeTruthy();
  });
});

describe("status derivation (§6)", () => {
  const log = (events: object[]) => {
    mkdirSync(join(sessions, "t-w1"), { recursive: true });
    writeFileSync(
      join(sessions, "t-w1", "log.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
  };
  const rosterWith = (spawned_at?: string) => {
    initTeam(TEAM);
    const roster = readTeam(TEAM)!;
    roster.agents["w1"] = { role: "r", engine: "claude", session: "t-w1", cwd: "/", spawned_at };
    writeTeam(TEAM, roster);
  };
  const now = Math.floor(Date.now() / 1000);

  it("idle after agent_turn_end", () => {
    rosterWith();
    log([
      { type: "agent_session_start", t: now - 100, continuation: "x" },
      { type: "agent_text", t: now - 50, text: "hi" },
      { type: "agent_turn_end", t: now - 40 },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("idle");
  });
  it("working after text", () => {
    rosterWith();
    log([
      { type: "agent_session_start", t: now - 100, continuation: "x" },
      { type: "agent_text", t: now - 5, text: "thinking..." },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("working");
  });
  it("waiting on an unanswered trip-message-wait Bash call", () => {
    rosterWith();
    log([
      { type: "agent_session_start", t: now - 100, continuation: "x" },
      { type: "agent_tool_call", t: now - 5, id: "c1", name: "Bash", input: { command: "trip message wait" } },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("waiting");
  });
  it("working again once the wait call is answered", () => {
    rosterWith();
    log([
      { type: "agent_session_start", t: now - 100, continuation: "x" },
      { type: "agent_tool_call", t: now - 10, id: "c1", name: "Bash", input: { command: "trip message wait" } },
      { type: "agent_tool_result", t: now - 5, tool_call_id: "c1", output: "1 message(s)", is_error: false },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("working");
  });
  it("starting when spawned_at postdates every event — the old incarnation's idle is invisible", () => {
    rosterWith(new Date().toISOString());
    log([
      { type: "agent_session_start", t: now - 1000, continuation: "x" },
      { type: "agent_turn_end", t: now - 900 },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("starting");
  });
  it("unknown when trip on never fired", () => {
    rosterWith();
    log([{ type: "output", t: now - 5, data: "shell noise" }]);
    expect(deriveStatus(TEAM, "w1")).toBe("unknown");
  });
  it("the boundary scopes out the previous incarnation's log", () => {
    rosterWith();
    log([
      { type: "agent_session_start", t: now - 1000, continuation: "old" },
      { type: "agent_turn_end", t: now - 900 },
      { type: "agent_session_start", t: now - 100, continuation: "new" },
      { type: "agent_text", t: now - 5, text: "busy" },
    ]);
    expect(deriveStatus(TEAM, "w1")).toBe("working");
  });
});

describe("agent.json repair timing", () => {
  it("leaves the file absent longer than the tailer's 300ms poll", async () => {
    const session = "t-timing";
    mkdirSync(join(sessions, session), { recursive: true });
    writeFileSync(join(sessions, session, "agent.json"), JSON.stringify({ kind: "codex", log_path: "/p" }));
    const started = Date.now();
    await verifyAgentRegistration(session, "claude");
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(readFileSync(join(sessions, session, "agent.json"), "utf8")).kind).toBe("claude");
  });
});
