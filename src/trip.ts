import { spawn, ChildProcess, execFile } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface TripEvent {
  type: string;
  text?: string;
  code?: number;
  message?: string;
}

export class TripSession extends EventEmitter {
  private proc: ChildProcess;
  private rl: ReturnType<typeof createInterface>;
  readonly name: string;

  constructor(name: string, command?: string[]) {
    super();
    this.name = name;

    const args = command?.length
      ? ["wrap", name, "--", ...command]
      : ["wrap", name];

    this.proc = spawn("trip", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });

    this.rl.on("line", (line) => {
      try {
        const event: TripEvent = JSON.parse(line);
        this.emit("event", event);
        this.emit(event.type, event);
      } catch {}
    });

    this.proc.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg.startsWith("session: ")) {
        this.emit("session", msg.slice(9));
      }
      this.emit("stderr", msg);
    });

    this.proc.on("close", () => {
      this.emit("close");
    });
  }

  send(text: string) {
    this.write({ type: "send", text });
  }

  key(key: string) {
    this.write({ type: "key", key });
  }

  screenshot(): Promise<string> {
    return new Promise((resolve) => {
      this.once("screen", (event: TripEvent) => {
        resolve(event.text ?? "");
      });
      this.write({ type: "screenshot" });
    });
  }

  resize(cols: number, rows: number) {
    this.write({ type: "resize", cols, rows });
  }

  close() {
    this.write({ type: "close" });
  }

  private write(event: Record<string, unknown>) {
    this.proc.stdin?.write(JSON.stringify(event) + "\n");
  }
}

export async function tripExec(
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("trip", args);
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

export async function tripLs(all = false): Promise<string> {
  const args = all ? ["ls", "-a"] : ["ls"];
  const { stdout } = await tripExec(...args);
  return stdout.trim();
}

export async function tripKill(name: string): Promise<string> {
  const { stdout, stderr } = await tripExec("kill", name);
  return (stdout || stderr).trim();
}
