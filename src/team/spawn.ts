/**
 * Spawning (§7) and its fail-first checks (§16, step 0). One chokepoint:
 * the CLI, team dispatch, and the Phase 3 watcher all inherit these.
 */
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { teamDir, validId } from "./paths.js";
import {
  Team,
  AgentRow,
  readTeam,
  writeTeam,
  DEFAULT_LIMITS,
} from "./roster.js";
import { bus, RESERVED_SENDER } from "./mailbox.js";
import { sessionName } from "./status.js";
import { agentJsonPath, readAgentConfig } from "../trip/log.js";
import {
  protocolPath,
  protocolText,
  teammatePrompt,
  agentsMdText,
} from "./protocol.js";

export type Engine = "claude" | "codex";

export interface SpawnOptions {
  role: string;
  engine?: Engine;
  worktree?: boolean;
  yolo?: boolean;
  /** Engine model: an alias (opus, sonnet, fable, o3, …) or a full name. */
  model?: string;
  /** Reasoning effort. Claude's levels are validated against its enum;
   *  codex gets the value passed through UNVALIDATED — whether codex
   *  rejects or silently ignores an unknown value is unconfirmed, which is
   *  why team ls displays effort: the operator can see what was asked. */
  effort?: string;
  /** Set by the Phase 3 watcher; the CLI always passes false. */
  auto?: boolean;
  /** Override the prompt (the coordinator's differs, §17). */
  prompt?: string;
  cwd?: string;
  /** How long to wait for trip on's agent.json (tests shorten it). */
  registrationTimeoutMs?: number;
  /** Set only by team start: this spawn IS the coordinator's own row. */
  coordinator?: boolean;
}

export function tripExec(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  try {
    return execFileSync("trip", args, {
      encoding: "utf8",
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"], // stderr lands on the error object
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("trip is not on PATH — install trip, or check PATH");
    }
    throw err;
  }
}

function tripErrorText(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  return `${e.stderr ?? ""}${e.message ?? ""}`;
}

/** Liveness comes from trip's session list, never from files — the session
 *  directory outlives every kill and crash (trip-primitives.md). Parsed
 *  tolerantly: the name appearing as a token means alive. */
/**
 * The coordinator is itself a Claude or Codex CLI, and `trip create` hands the
 * child the caller's whole environment (docs/trip-primitives.md). So a
 * teammate spawned by a coordinator inherits the coordinator's own agent
 * markers, and three of them are actively harmful:
 *
 *   CLAUDE_CODE_CHILD_SESSION  the child disables transcript saving, so there
 *                              is no transcript for `trip on` to register and
 *                              every spawn fails registration
 *   CLAUDE_CODE_SESSION_ID     `trip on` resolves the *coordinator's* session
 *   CODEX_THREAD_ID            (client/mod.rs:626,635), registering the
 *                              teammate against its manager's transcript —
 *                              §6 would then derive the teammate's status from
 *                              the coordinator's events, silently
 *   CLAUDE_CODE_MESSAGING_*    the parent's IPC socket and its auth token
 *
 * A teammate is a fresh agent, not a child of the coordinator's session, so
 * the whole family is dropped and each engine re-establishes its own.
 */
const INHERITED_AGENT_MARKERS = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDECODE",
  // The tier and tuning are decided per teammate at spawn (§9), so an
  // inherited value must not quietly outrank the flag that was passed.
  "CLAUDE_EFFORT",
  "CLAUDE_MODEL",
  "CODEX_THREAD_ID",
];

/** Everything an engine puts in the environment looks like one of these.
 *  Used by the test that guards the list above against the day an engine
 *  adds a tenth marker; not used to scrub, because plenty of what matches is
 *  config a teammate genuinely needs. */
export const AGENT_ENV_PATTERN = /^CLAUDE(CODE|_)|^CODEX_/;

/** Matches AGENT_ENV_PATTERN and is deliberately inherited: it tells a
 *  teammate where its own config and credentials live, which is not identity
 *  and not the parent's session. */
export const INHERITED_AGENT_CONFIG = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CODEX_HOME",
];

/** The environment a spawned teammate gets: the caller's, minus the caller's
 *  own agent identity, plus this teammate's. */
export function teammateEnv(team: string, id: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_AGENT_MARKERS) delete env[key];
  return { ...env, TRIP_TEAM: team, TRIP_AGENT: id };
}

export function sessionAlive(session: string): boolean {
  let out: string;
  try {
    out = tripExec(["ls", "-a"]);
  } catch {
    return false; // no daemon, no sessions
  }
  const token = new RegExp(`(^|\\s)${session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m");
  return token.test(out);
}

/** Tolerate exactly the error the primitives name; rethrow the rest. */
export function tripKillTolerant(session: string): void {
  try {
    tripExec(["kill", session]);
  } catch (err: unknown) {
    // trip quotes the name: "session 'proof-w1' not found". Matching the
    // literal "session not found" never fired against a real trip, so a
    // respawn of an already-dead teammate failed at step 3 — which is the
    // ordinary case the watcher hits every time a session dies. Only the
    // stub said it unquoted, so the suite agreed with the bug.
    if (/session (?:'[^']*' )?not found/.test(tripErrorText(err))) return;
    throw err;
  }
}

/** Where the shipped plugin lives, resolved from this module rather than the
 *  caller's cwd: dist/team/spawn.js -> the package root -> plugin/. */
export function pluginDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");
}

/** The SessionStart hook both engines run to register with trip.
 *  Failure is swallowed: outside a trip session `trip on` has nothing to do,
 *  and a hook that errors on every plain shell is worse than no hook. */
const REGISTER_HOOK = "trip on >/dev/null 2>&1 || true";

/** Codex takes the same hook shape as its config file, injected per launch as
 *  TOML on the command line, so tripping never edits ~/.codex/config.toml.
 *
 *  Codex gates a new or changed hook behind its own "Hooks need review"
 *  dialog, so an auto-tier spawn parks until a human answers it once. That is
 *  a choice, not a limitation — `--dangerously-bypass-hook-trust` would skip
 *  it — and the choice is deliberate: hooks run outside Codex's sandbox,
 *  which is precisely why `trip on` needs to be one (from an ordinary Codex
 *  shell it fails with "Operation not permitted", seatbelt denying the write
 *  to ~/.trip/sessions/). Burning a real trust boundary by default is worse
 *  than one human answer. The yolo tier passes the flag, because that tier
 *  has already surrendered approvals and the sandbox. §8's guard detects the
 *  dialog either way, so an auto-tier teammate parks visibly. */
const CODEX_HOOK_CONFIG =
  `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(REGISTER_HOOK)}}]}]`;

/** Claude's --effort levels, from its own --help. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const TUNING_TOKEN = /^[A-Za-z0-9._/:-]+$/;

export interface EngineTuning {
  model?: string;
  effort?: string;
}

export function validateTuning(engine: Engine, tuning: EngineTuning): void {
  if (tuning.model !== undefined && !TUNING_TOKEN.test(tuning.model)) {
    throw new Error(`invalid model '${tuning.model}'`);
  }
  if (tuning.effort === undefined) return;
  if (engine === "claude" && !CLAUDE_EFFORT_LEVELS.includes(tuning.effort)) {
    throw new Error(
      `unknown effort '${tuning.effort}' for claude — one of: ${CLAUDE_EFFORT_LEVELS.join(", ")}`
    );
  }
  if (engine === "codex" && !/^[a-z]+$/.test(tuning.effort)) {
    throw new Error(`invalid effort '${tuning.effort}' for codex`);
  }
}

/** §9: every launch carries an autonomy tier; there is no interactive tier.
 *  Model and effort ride along when set — claude via --model/--effort, codex
 *  via -m and -c model_reasoning_effort=… (both verified against the
 *  installed binaries). Registration rides along too, and the order is load
 *  bearing: tier flags first, then tuning as one contiguous run, then
 *  registration, then the prompt last. */
export function engineCommand(
  engine: Engine,
  yolo: boolean,
  prompt: string,
  tuning: EngineTuning = {}
): string[] {
  validateTuning(engine, tuning);
  if (engine === "claude") {
    return [
      "claude",
      "--permission-mode",
      yolo ? "bypassPermissions" : "auto",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.effort ? ["--effort", tuning.effort] : []),
      // Session-scoped: carries the SessionStart hook that runs `trip on` and
      // the trip-team skill. Without registration §6 can derive nothing at
      // all, so this is load-bearing, not a convenience.
      "--plugin-dir",
      pluginDir(),
      prompt,
    ];
  }
  return [
    "codex",
    ...(yolo
      ? [
          "--dangerously-bypass-approvals-and-sandbox",
          // Hook trust is a real boundary — hooks run outside the sandbox —
          // so the auto tier keeps it and a Codex teammate parks once for a
          // human to answer. The yolo tier has already given up approvals and
          // the sandbox itself (§9); withholding hook trust there protects
          // nothing that is left, and it would park the one tier whose whole
          // point is running unattended.
          "--dangerously-bypass-hook-trust",
        ]
      : ["--approve-for-me"]),
    ...(tuning.model ? ["-m", tuning.model] : []),
    ...(tuning.effort ? ["-c", `model_reasoning_effort=${tuning.effort}`] : []),
    "-c",
    CODEX_HOOK_CONFIG,
    prompt,
  ];
}

/** Only the coordinator or a human shell may spawn, respawn, or kill. */
export function callerGate(roster: Team): void {
  const caller = process.env.TRIP_AGENT;
  if (caller && caller !== roster.coordinator) {
    throw new Error(
      `teammates cannot spawn or kill (v1). Ask the coordinator: trip message send coordinator --kind question`
    );
  }
}

export interface CheckOptions {
  /** team start spawning the coordinator's own row (§17). */
  asCoordinator?: boolean;
  /** Set by the Phase 3 watcher; gates the §16 crash-loop breaker. */
  auto?: boolean;
}

/** Step 0 (§7/§16): fail first, before any worktree or session exists.
 *  Every refusal is audited to bus.jsonl when the team is readable. */
export function checkSpawn(
  team: string,
  id: string,
  opts: CheckOptions = {}
): Team {
  const roster = readTeam(team);
  const refuse = (reason: string): never => {
    if (roster !== null) {
      bus(team, {
        event: "spawn_refused",
        agent: id,
        by: opts.auto ? "watcher" : process.env.TRIP_AGENT ?? "human",
        reason,
      });
    }
    throw new Error(reason);
  };
  if (roster === null) {
    throw new Error(`no team.json for '${team}' — run: trip team init ${team}`);
  }
  const caller = process.env.TRIP_AGENT;
  if (caller && caller !== roster.coordinator) {
    refuse(
      `teammates cannot spawn or kill (v1). Ask the coordinator: trip message send coordinator --kind question`
    );
  }
  if (!validId(id)) refuse(`invalid agent id: ${id}`);
  if (opts.asCoordinator) {
    if (id !== roster.coordinator)
      refuse(`the coordinator's id is '${roster.coordinator}'`);
  } else if (
    id === RESERVED_SENDER ||
    id === "coordinator" ||
    id === roster.coordinator
  ) {
    // The alias and the id that holds the role are both off-limits to
    // teammate spawns (§4); the reserved sender always is.
    refuse(`'${id}' is reserved`);
  }
  const existing = roster.agents[id];
  if (existing && !existing.killed_at && sessionAlive(sessionName(team, id))) {
    // Alive means the daemon says so — a dead session with a live roster
    // row is exactly the recreate case (§17), so it passes.
    refuse(
      `'${id}' is already live — respawn requires a kill first: trip team kill ${id}`
    );
  }
  if (opts.auto) {
    const restarts = existing?.restarts_since_human ?? 0;
    if (restarts >= roster.limits.max_respawns) {
      refuse(
        `'${id}' crashed ${restarts}x; leaving it down (limits.max_respawns). ` +
          `Autopsy: trip log ${sessionName(team, id)}. ` +
          `A deliberate trip team spawn resets the breaker.`
      );
    }
  }
  if (!opts.asCoordinator) {
    const live = Object.entries(roster.agents).filter(
      ([aid, row]) => aid !== roster.coordinator && !row.killed_at
    ).length;
    if (live >= roster.limits.max_agents && !(existing && !existing.killed_at)) {
      refuse(
        `${live}/${roster.limits.max_agents} teammates live (limits.max_agents in ` +
          `~/.trip/teams/${team}/team.json). Free a slot: trip team kill <id>. ` +
          `Raising the cap is a human edit of team.json.`
      );
    }
  }
  return roster;
}

export function initTeam(
  team: string,
  opts: { maxAgents?: number; maxRespawns?: number; coordinator?: string } = {}
): Team {
  if (!validId(team)) throw new Error(`invalid team id: ${team}`);
  const existing = readTeam(team);
  if (existing) return existing;
  for (const [flag, value] of [
    ["--max-agents", opts.maxAgents],
    ["--max-respawns", opts.maxRespawns],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${flag} must be a positive integer`);
    }
  }
  const roster: Team = {
    coordinator: opts.coordinator ?? "coordinator",
    limits: {
      max_agents: opts.maxAgents ?? DEFAULT_LIMITS.max_agents,
      max_respawns: opts.maxRespawns ?? DEFAULT_LIMITS.max_respawns,
    },
    agents: {},
  };
  if (roster.coordinator === RESERVED_SENDER)
    throw new Error(`'${RESERVED_SENDER}' is reserved`);
  if (!validId(roster.coordinator))
    throw new Error(`invalid coordinator id: ${roster.coordinator}`);
  writeTeam(team, roster);
  writeFileSync(protocolPath(team), protocolText(team));
  return roster;
}

/** Wait for trip on's agent.json, verify kind, repair by remove-then-write —
 *  leaving the file absent longer than the tailer's 300ms poll, or the old
 *  tailer never observes the removal (trip-primitives.md). */
export async function verifyAgentRegistration(
  session: string,
  engine: Engine,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const config = readAgentConfig(session);
    if (config) {
      if (config.kind === engine) return;
      unlinkSync(agentJsonPath(session));
      await new Promise((r) => setTimeout(r, 400)); // outlive the 300ms poll
      writeFileSync(
        agentJsonPath(session),
        JSON.stringify({ kind: engine, log_path: config.log_path }) + "\n"
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `agent.json never appeared for ${session} — either trip on did not ` +
          `fire, or the engine died at launch (a mistyped --model fails ` +
          `there, not here): check trip screen ${session} first. ` +
          `Is the SessionStart hook configured? Autopsy: trip log ${session}`
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface SpawnResult {
  id: string;
  session: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  /** §7 step 2: the one-line AGENTS.md reference the human may adopt. */
  protocolReference?: string;
}

export async function spawnTeammate(
  team: string,
  id: string,
  opts: SpawnOptions
): Promise<SpawnResult> {
  if (opts.engine && opts.engine !== "claude" && opts.engine !== "codex") {
    throw new Error(`unknown engine '${opts.engine}' — use claude or codex`);
  }
  validateTuning(opts.engine ?? "claude", opts); // fail before any side effect
  const roster = checkSpawn(team, id, {
    asCoordinator: !!opts.coordinator,
    auto: !!opts.auto,
  });
  const engine: Engine = opts.engine ?? "claude";
  const session = sessionName(team, id);
  const repoCwd = opts.cwd ?? process.cwd();

  // Worktree for writer roles: wt/<id> in the team dir, branch team/<team>/<id>.
  let cwd = repoCwd;
  let protocolReferenceNeeded = !opts.worktree; // worktree-less roles too
  let worktree: string | undefined;
  let branch: string | undefined;
  if (opts.worktree) {
    worktree = join(teamDir(team), "wt", id);
    branch = `team/${team}/${id}`;
    mkdirSync(join(teamDir(team), "wt"), { recursive: true });
    if (!existsSync(worktree)) {
      execFileSync("git", ["worktree", "add", worktree, "-b", branch], {
        cwd: repoCwd,
        encoding: "utf8",
      });
    }
    // The worktree copy of the contract, re-entering context per compaction.
    const dotDir = join(worktree, ".tripping");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "PROTOCOL.md"), protocolText(team));
    // tripping never edits the repo's own files: create AGENTS.md/CLAUDE.md
    // only when the repo ships none, and otherwise leave the printed
    // reference (§7 step 2) to the human. The created files stay untracked
    // and visible — there is no worktree-scoped git exclude (info/exclude
    // resolves to the COMMON git dir and would hide files in the user's own
    // checkout), so §15's checkpoint excludes them by pathspec instead.
    const agentsMd = join(worktree, "AGENTS.md");
    if (!existsSync(agentsMd)) {
      writeFileSync(agentsMd, agentsMdText(team));
    } else {
      protocolReferenceNeeded = true;
    }
    const claudeMd = join(worktree, "CLAUDE.md");
    if (!existsSync(claudeMd)) {
      try {
        symlinkSync("AGENTS.md", claudeMd);
      } catch {
        /* AGENTS.md exists either way; the reference is what matters */
      }
    }
    cwd = worktree;
  }

  // A dead session with a live roster row is the recreate case: free the
  // name first — trip create hard-errors on a held one (§15 step 3).
  const prior = roster.agents[id];
  if (prior) tripKillTolerant(session);

  // Roster row before create: spawned_at first is what §6 derives from.
  // The breaker counter increments on the watcher's auto path and resets
  // on a deliberate spawn — the reset IS the human/coordinator touch (§16).
  const row: AgentRow = {
    role: opts.role,
    engine,
    session,
    cwd,
    ...(worktree ? { worktree, branch } : {}),
    ...(opts.yolo ? { yolo: true } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    spawned_at: new Date().toISOString(),
    spawns: (prior?.spawns ?? 0) + 1,
    restarts_since_human: opts.auto
      ? (prior?.restarts_since_human ?? 0) + 1
      : 0,
  };
  roster.agents[id] = row;
  writeTeam(team, roster);
  bus(team, {
    event: "spawn",
    agent: id,
    by: opts.auto ? "watcher" : process.env.TRIP_AGENT ?? "human",
    engine,
  });

  const protocolRef = worktree
    ? ".tripping/PROTOCOL.md"
    : protocolPath(team);
  const prompt =
    opts.prompt ?? teammatePrompt(team, id, opts.role, protocolRef);
  tripExec(["create", session, "--", ...engineCommand(engine, !!opts.yolo, prompt, opts)], {
    cwd,
    env: teammateEnv(team, id),
  });

  await verifyAgentRegistration(session, engine, opts.registrationTimeoutMs);
  return {
    id,
    session,
    cwd,
    worktree,
    branch,
    ...(protocolReferenceNeeded
      ? {
          protocolReference: `add to your AGENTS.md: Read ${protocolPath(team)} — the messaging contract for team ${team}`,
        }
      : {}),
  };
}

/** Kill: trip kill first — the name frees at the daemon regardless of what
 *  happens next — then stamp killed_at; rerunning is the crash recovery. */
export function killTeammate(team: string, id: string): void {
  const roster = readTeam(team);
  if (roster === null) throw new Error(`no team.json for '${team}'`);
  const caller = process.env.TRIP_AGENT;
  if (caller && caller !== roster.coordinator) {
    throw new Error(
      `teammates cannot spawn or kill (v1). Ask the coordinator: trip message send coordinator --kind question`
    );
  }
  if (!roster.agents[id]) throw new Error(`'${id}' is not on the roster`);
  tripKillTolerant(sessionName(team, id));
  roster.agents[id].killed_at = new Date().toISOString();
  writeTeam(team, roster);
  bus(team, { event: "kill", agent: id, by: caller ?? "human" });
}
