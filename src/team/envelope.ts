/** One message on the bus. A file exists in exactly one maildir directory. */
export const KINDS = [
  "task",
  "result",
  "question",
  "answer",
  "note",
  "control",
] as const;
export type Kind = (typeof KINDS)[number];

export interface Message {
  id: string;
  from: string;
  to: string;
  kind: Kind;
  /** Correlation id. A fresh task's thread defaults to its own id. */
  thread: string;
  reply_to?: string;
  subject: string;
  body: string;
  artifacts?: string[];
  ts: number;
}

// Crockford base32, per ULID: 10 chars of time, 16 of randomness.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: number[] = [];

const freshRandom = () =>
  Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));

/** Sortable id: lexicographic order is time order, monotonic in-process. */
export function newId(now = Date.now()): string {
  let random: number[];
  if (now <= lastTime) {
    // Same millisecond, or a clock that stepped backwards: stay at lastTime
    // and increment the previous randomness so order holds regardless.
    now = lastTime;
    random = [...lastRandom];
    let carried = true;
    for (let i = random.length - 1; i >= 0; i--) {
      if (++random[i] < 32) {
        carried = false;
        break;
      }
      random[i] = 0;
    }
    if (carried) {
      // Suffix overflowed: carry into the time component instead of wrapping.
      now = lastTime + 1;
      random = freshRandom();
    }
  } else {
    random = freshRandom();
  }
  lastTime = now;
  lastRandom = random;

  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((r) => ALPHABET[r]).join("");
}

export interface Draft {
  from: string;
  to: string;
  kind: Kind;
  subject: string;
  body: string;
  thread?: string;
  reply_to?: string;
  artifacts?: string[];
}

export function makeMessage(draft: Draft): Message {
  const id = newId();
  return {
    id,
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    // A fresh task's thread defaults to its own id, so working/<id>.json and
    // its result's --thread name the same string.
    thread: draft.thread ?? (draft.kind === "task" ? id : ""),
    ...(draft.reply_to ? { reply_to: draft.reply_to } : {}),
    subject: draft.subject,
    body: draft.body,
    ...(draft.artifacts?.length ? { artifacts: draft.artifacts } : {}),
    ts: Math.floor(Date.now() / 1000),
  };
}
