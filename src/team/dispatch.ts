/**
 * Deterministic fan-out and fan-in (§4): dispatch tasks, optionally block
 * until every thread carries a result. The reconcile sweep runs inside the
 * poll loop, so fan-in fails fast on a dead teammate instead of hanging —
 * a park mail from `tripping` satisfies a join as a failure (§15).
 */
import { readBus, send } from "./mailbox.js";
import { RESERVED_SENDER } from "./mailbox.js";
import { sweepOnce } from "./watcher.js";

export interface TaskSpec {
  to: string;
  subject: string;
  body: string;
}

export interface DispatchOutcome {
  thread: string;
  to: string;
  subject: string;
  /** set once a result lands; "tripping" means the join failed (§15) */
  resultFrom?: string;
}

export function dispatchTasks(
  team: string,
  from: string,
  tasks: TaskSpec[]
): DispatchOutcome[] {
  return tasks.map((task) => {
    const { message } = send(team, {
      from,
      to: task.to,
      kind: "task",
      subject: task.subject,
      body: task.body,
    });
    return { thread: message.thread, to: message.to, subject: task.subject };
  });
}

export async function awaitResults(
  team: string,
  outcomes: DispatchOutcome[],
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<{ done: DispatchOutcome[]; pending: DispatchOutcome[] }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const poll = opts.pollMs ?? 2000;
  for (;;) {
    await sweepOnce(team); // fail-fast: dead teammates re-deliver or park
    const lines = readBus(team);
    for (const outcome of outcomes) {
      if (outcome.resultFrom) continue;
      const hit = lines.find(
        (l) =>
          l.event === "message" &&
          l.kind === "result" &&
          l.thread === outcome.thread
      );
      if (hit) outcome.resultFrom = hit.from as string;
    }
    const pending = outcomes.filter((o) => !o.resultFrom);
    if (pending.length === 0 || Date.now() >= deadline) {
      return { done: outcomes.filter((o) => o.resultFrom), pending };
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

export const joinFailed = (o: DispatchOutcome): boolean =>
  o.resultFrom === RESERVED_SENDER;
