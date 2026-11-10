import { diff, encode, type ServerMessage } from "@quiz/protocol";
import type { View, Viewer } from "@quiz/schema";
import type { ViewSink } from "./session-runtime.ts";

/** Minimal transport surface, so view streaming is testable without sockets. */
export type Wire = { send(data: string): void; readonly bufferedAmount: number };

/** Above this many queued bytes a client is "slow": we stop queuing patches and resend a snapshot later (ADR-0009). */
export const SLOW_CLIENT_BYTES = 256 * 1024;

/** Drops `undefined` members so diffs only see JSON (the engine output is already a valid View). */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON round-trip of a View is still that View minus undefined members
const normalize = (v: View): View => JSON.parse(JSON.stringify(v)) as View;

/**
 * Per-connection view stream: owns `viewSeq`, sends patches when cheaper than the view,
 * snapshots on resync / slow client. Implements ViewSink for the runtime.
 */
export class ViewStream implements ViewSink {
  private last: View | null = null;
  private seq = 0;
  private dirty = false;

  readonly viewer: Viewer;
  private readonly wire: Wire;

  constructor(viewer: Viewer, wire: Wire) {
    this.viewer = viewer;
    this.wire = wire;
  }

  get viewSeq(): number {
    return this.seq;
  }

  /** The welcome carries the first snapshot (viewSeq 0). */
  welcome(view: View, serverTime: number, v: number): void {
    this.last = normalize(view);
    this.seq = 0;
    this.dirty = false;
    this.send({ t: "welcome", v, viewer: this.viewer, serverTime, viewSeq: 0, view: this.last });
  }

  update(view: View): void {
    const next = normalize(view);
    if (this.wire.bufferedAmount > SLOW_CLIENT_BYTES) {
      this.dirty = true; // don't pile up patches on a slow client
      this.last = next;
      return;
    }
    if (this.dirty || this.last === null) {
      this.snapshot(next);
      return;
    }
    const ops = diff(this.last, next);
    if (ops.length === 0) return;
    this.last = next;
    const patch = JSON.stringify(ops);
    if (patch.length >= JSON.stringify(next).length) this.send({ t: "snapshot", viewSeq: ++this.seq, view: next });
    else this.send({ t: "patch", viewSeq: ++this.seq, ops });
  }

  /** Called by a periodic sweep: a slow client that caught up gets a fresh snapshot. */
  flushIfCaughtUp(): void {
    if (this.dirty && this.last !== null && this.wire.bufferedAmount <= SLOW_CLIENT_BYTES) this.snapshot(this.last);
  }

  resync(view: View): void {
    this.snapshot(normalize(view));
  }

  private snapshot(view: View): void {
    this.last = view;
    this.dirty = false;
    this.send({ t: "snapshot", viewSeq: ++this.seq, view });
  }

  private send(m: ServerMessage): void {
    this.wire.send(encode(m));
  }
}
