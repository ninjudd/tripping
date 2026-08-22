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
  verifyAgentRegistration, sessionAlive, teammateEnv,
  AGENT_ENV_PATTERN, INHERITED_AGENT_CONFIG,
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
  // Mirrors real trip: kill leaves the session directory in place (the log
  // outlives the session); ls -a is the only liveness source.
  const stub = `#!/bin/sh
echo "$@" >> "${stubDir}/calls.log"
case "$1" in
  create)
    mkdir -p "${sessions}/$2"
    : > "${sessions}/$2/log.jsonl"
    printf '{"kind":"${kind}","log_path":"/fake/transcript.jsonl"}\\n' > "${sessions}/$2/agent.json"
    env | grep -E '^TRIP_(TEAM|AGENT)=' >> "${stubDir}/calls.log"
    echo "$2" >> "${stubDir}/live.txt"
    ;;
  kill)
    if grep -qx "$2" "${stubDir}/live.txt" 2>/dev/null; then
      grep -vx "$2" "${stubDir}/live.txt" > "${stubDir}/live.tmp" || true
      mv "${stubDir}/live.tmp" "${stubDir}/live.txt"
    else
      echo "session not found" >&2; exit 1
    fi
    ;;
  ls)
    cat "${stubDir}/live.txt" 2>/dev/null || true
    ;;
esac
`;
  writeFileSync(join(stubDir, "trip"), stub);
  chmodSync(join(stubDir, "trip"), 0o755);
}

function markDead(session: string): void {
  const live = join(stubDir, "live.txt");
  if (existsSync(live)) {
    const rest = readFileSync(live, "utf8").split("\n").filter((l) => l && l !== session);
    writeFileSync(live, rest.join("\n") + (rest.length ? "\n" : ""));
  }
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
    appendFileSync(join(stubDir, "live.txt"), "t-w1\n"); // daemon agrees: live
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
    expect(() => checkSpawn(TEAM, "coordinator", { asCoordinator: true })).not.toThrow();
    expect(() => checkSpawn(TEAM, "someone-else", { asCoordinator: true })).toThrow(/coordinator's id/);
  });
  it("the coordinator spawn is exempt from the teammate cap", () => {
    const roster = initTeam(TEAM);
    for (let i = 0; i < DEFAULT_LIMITS.max_agents; i++) {
      roster.agents[`w${i}`] = { role: "r", engine: "claude", session: `t-w${i}`, cwd: "/" };
    }
    writeTeam(TEAM, roster);
    expect(() => checkSpawn(TEAM, "coordinator", { asCoordinator: true })).not.toThrow();
  });
});

describe("teammateEnv: the coordinator's own markers never reach a teammate", () => {
  it("drops the parent agent's session identity and IPC channel", () => {
    // A coordinator is itself a Claude or Codex CLI, and trip create hands
    // the child the caller's whole environment. Every key below was observed
    // leaking into a real spawned teammate.
    const saved = { ...process.env };
    Object.assign(process.env, {
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "secret",
      CLAUDECODE: "1",
      CLAUDE_EFFORT: "xhigh",
      CODEX_THREAD_ID: "parent-thread",
    });
    try {
      const env = teammateEnv("t", "w1");
      for (const key of [
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDECODE",
        "CLAUDE_EFFORT",
        "CODEX_THREAD_ID",
      ]) {
        expect(env[key], key).toBeUndefined();
      }
      // Everything else still comes through — a teammate needs the caller's
      // PATH and credentials to run at all.
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.TRIP_TEAM).toBe("t");
      expect(env.TRIP_AGENT).toBe("w1");
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("leaves no agent variable of this real session unaccounted for", () => {
    // The list in spawn.ts is hand-maintained over someone else's
    // environment, and the test above can only check it against itself. This
    // one checks it against reality: every CLAUDE*/CODEX_* variable actually
    // present must be either scrubbed or a deliberate keep. When an engine
    // adds a marker, this fails and someone decides which it is.
    const present = Object.keys(process.env).filter((k) =>
      AGENT_ENV_PATTERN.test(k)
    );
    if (present.length === 0) return; // not running inside an agent session
    const env = teammateEnv("t", "w1");
    const leaked = present.filter(
      (k) => env[k] !== undefined && !INHERITED_AGENT_CONFIG.includes(k)
    );
    expect(
      leaked,
      `unaccounted agent variables — scrub them in INHERITED_AGENT_MARKERS, ` +
        `or add them to INHERITED_AGENT_CONFIG if a teammate needs them`
    ).toEqual([]);
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
  it("never touches the user's own git exclude", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "w", worktree: true, cwd: repo });
    const exclude = join(repo, ".git", "info", "exclude");
    if (existsSync(exclude)) {
      const text = readFileSync(exclude, "utf8");
      expect(text).not.toContain("AGENTS.md");
      expect(text).not.toContain(".tripping");
    }
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
    // the log outlives the session — kill never removes the directory
    expect(existsSync(join(sessions, "t-w1", "log.jsonl"))).toBe(true);
    killTeammate(TEAM, "w1"); // stub kill now errors; stamping is the recovery
    expect(readTeam(TEAM)!.agents["w1"].killed_at).toBeTruthy();
  });
  it("only 'session not found' is tolerated; other kill failures rethrow", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    writeFileSync(join(stubDir, "trip"), "#!/bin/sh\necho daemon exploded >&2; exit 1\n");
    chmodSync(join(stubDir, "trip"), 0o755);
    expect(() => killTeammate(TEAM, "w1")).toThrow(/daemon exploded/);
    expect(readTeam(TEAM)!.agents["w1"].killed_at).toBeUndefined();
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
  it("starting is bounded: long silence past registration derives unknown", () => {
    rosterWith(new Date(Date.now() - 5 * 60_000).toISOString()); // spawned 5m ago
    log([]); // registered nothing, ever
    expect(deriveStatus(TEAM, "w1")).toBe("unknown");
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

describe("liveness and recreate (§17)", () => {
  it("sessionAlive comes from trip ls, not the filesystem", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    expect(sessionAlive("t-w1")).toBe(true);
    markDead("t-w1"); // crash: daemon reaped it, directory remains
    expect(existsSync(join(sessions, "t-w1"))).toBe(true);
    expect(sessionAlive("t-w1")).toBe(false);
  });
  it("a dead session with a live roster row passes the already-live gate", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    expect(() => checkSpawn(TEAM, "w1")).toThrow(/already live/);
    markDead("t-w1");
    expect(() => checkSpawn(TEAM, "w1")).not.toThrow();
    // and the respawn kills the held name first, tolerating not-found
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    expect(readTeam(TEAM)!.agents["w1"].spawns).toBe(2);
  });
});

describe("crash-loop breaker (§16)", () => {
  it("auto respawns increment the counter and trip the breaker", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    for (let i = 0; i < DEFAULT_LIMITS.max_respawns; i++) {
      markDead("t-w1");
      await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo, auto: true });
    }
    expect(readTeam(TEAM)!.agents["w1"].restarts_since_human).toBe(3);
    markDead("t-w1");
    await expect(
      spawnTeammate(TEAM, "w1", { role: "r", cwd: repo, auto: true })
    ).rejects.toThrow(/crashed 3x.*trip log t-w1/s);
  });
  it("a deliberate spawn resets the breaker", async () => {
    initTeam(TEAM);
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo });
    markDead("t-w1");
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo, auto: true });
    expect(readTeam(TEAM)!.agents["w1"].restarts_since_human).toBe(1);
    markDead("t-w1");
    await spawnTeammate(TEAM, "w1", { role: "r", cwd: repo }); // human touch
    expect(readTeam(TEAM)!.agents["w1"].restarts_since_human).toBe(0);
  });
});

describe("hand-built and corrupt team.json (§16, §7 step 0)", () => {
  it("a corrupt file refuses naming the path and recovery", () => {
    initTeam(TEAM);
    writeFileSync(join(process.env.TRIP_TEAMS_DIR!, TEAM, "team.json"), "{nope");
    expect(() => checkSpawn(TEAM, "w1")).toThrow(/corrupt.*trip team init/s);
  });
  it("a hand-built file missing limits gets defaults written back", () => {
    initTeam(TEAM);
    writeFileSync(
      join(process.env.TRIP_TEAMS_DIR!, TEAM, "team.json"),
      JSON.stringify({ coordinator: "coordinator", agents: {} })
    );
    const roster = readTeam(TEAM)!;
    expect(roster.limits).toEqual(DEFAULT_LIMITS);
    // and it was persisted, not just defaulted in memory
    expect(JSON.parse(readFileSync(join(process.env.TRIP_TEAMS_DIR!, TEAM, "team.json"), "utf8")).limits)
      .toEqual(DEFAULT_LIMITS);
  });
  it("init validates the coordinator id", () => {
    expect(() => initTeam("t9", { coordinator: "a.b" })).toThrow(/invalid/);
  });
  it("init refuses non-numeric limits instead of persisting null", () => {
    expect(() => initTeam("t9", { maxAgents: Number("abc") })).toThrow(/positive integer/);
    expect(() => initTeam("t9", { maxRespawns: 0 })).toThrow(/positive integer/);
  });
  it("the limits repair converges: a null limit becomes numeric once", () => {
    initTeam(TEAM);
    const path = join(process.env.TRIP_TEAMS_DIR!, TEAM, "team.json");
    writeFileSync(path, JSON.stringify({
      coordinator: "coordinator",
      limits: { max_agents: null, max_respawns: 3 },
      agents: {},
    }));
    expect(readTeam(TEAM)!.limits.max_agents).toBe(DEFAULT_LIMITS.max_agents);
    // persisted, so the next read has nothing to repair
    expect(JSON.parse(readFileSync(path, "utf8")).limits.max_agents).toBe(DEFAULT_LIMITS.max_agents);
  });
});

describe("engine validation and refusal audit", () => {
  it("an unknown engine is refused before any side effect", async () => {
    initTeam(TEAM);
    await expect(
      spawnTeammate(TEAM, "w1", { role: "r", cwd: repo, engine: "Claude" as never })
    ).rejects.toThrow(/unknown engine/);
  });
  it("refusals land in bus.jsonl", () => {
    initTeam(TEAM);
    process.env.TRIP_AGENT = "w1";
    expect(() => checkSpawn(TEAM, "w2")).toThrow();
    delete process.env.TRIP_AGENT;
    const bus = readFileSync(join(process.env.TRIP_TEAMS_DIR!, TEAM, "bus.jsonl"), "utf8");
    expect(bus).toContain('"event":"spawn_refused"');
  });
});

describe("waiting matcher (§6)", () => {
  it("does not fire on a non-Bash tool whose input quotes the loop", () => {
    initTeam(TEAM);
    const roster = readTeam(TEAM)!;
    roster.agents["w1"] = { role: "r", engine: "claude", session: "t-w1", cwd: "/" };
    writeTeam(TEAM, roster);
    const now = Math.floor(Date.now() / 1000);
    mkdirSync(join(sessions, "t-w1"), { recursive: true });
    writeFileSync(join(sessions, "t-w1", "log.jsonl"), [
      JSON.stringify({ type: "agent_session_start", t: now - 100, continuation: "x" }),
      JSON.stringify({ type: "agent_tool_call", t: now - 5, id: "c1", name: "Write",
        input: { path: "doc.md", content: "then run trip message wait" } }),
    ].join("\n") + "\n");
    expect(deriveStatus(TEAM, "w1")).toBe("working");
  });
  it("fires on the msg alias", () => {
    initTeam(TEAM);
    const roster = readTeam(TEAM)!;
    roster.agents["w1"] = { role: "r", engine: "claude", session: "t-w1", cwd: "/" };
    writeTeam(TEAM, roster);
    const now = Math.floor(Date.now() / 1000);
    mkdirSync(join(sessions, "t-w1"), { recursive: true });
    writeFileSync(join(sessions, "t-w1", "log.jsonl"), [
      JSON.stringify({ type: "agent_session_start", t: now - 100, continuation: "x" }),
      JSON.stringify({ type: "agent_tool_call", t: now - 5, id: "c1", name: "Bash",
        input: { command: "trip msg wait --timeout 550" } }),
    ].join("\n") + "\n");
    expect(deriveStatus(TEAM, "w1")).toBe("waiting");
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
