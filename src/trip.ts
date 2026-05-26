import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";

export interface TripEvent {
  type: string;
  text?: string;
  code?: number;
  message?: string;
}

export class TripSession extends EventEmitter {
  private proc: ChildProcess;
  private rl: ReturnType<typeof createInterface>;

  constructor(name: string, command: string[]) {
    super();
    this.proc = spawn("trip", ["wrap", name, "--", ...command], {
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
      this.emit("stderr", data.toString());
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
