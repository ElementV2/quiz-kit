import type { Log, Timers } from "../runtime/session-runtime.ts";

/** Manually driven clock + timers: tests decide when time passes. */
export class FakeTime implements Timers {
  now = 1_000_000;
  private next = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  readonly clock = (): number => this.now;

  set(fn: () => void, ms: number): () => void {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return () => this.pending.delete(id);
  }

  /** Advances time and fires due timers in order. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= this.now).toSorted((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) return;
      this.pending.delete(due[0]);
      due[1].fn();
    }
  }

  get armed(): number {
    return this.pending.size;
  }
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };

export class RecordingLog implements Log {
  readonly lines: { level: string; msg: string }[] = [];
  info(_o: object, msg: string): void {
    this.lines.push({ level: "info", msg });
  }
  warn(_o: object, msg: string): void {
    this.lines.push({ level: "warn", msg });
  }
  error(_o: object, msg: string): void {
    this.lines.push({ level: "error", msg });
  }
}
