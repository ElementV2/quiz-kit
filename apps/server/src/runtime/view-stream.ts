import { diff, encode, type ServerMessage } from "@quiz/protocol";
import type { View, Viewer } from "@quiz/schema";
import type { ViewFrame, ViewSink } from "./session-runtime.ts";

/** Minimal transport surface, so view streaming is testable without sockets. */
export type Wire = { send(data: string): void; readonly bufferedAmount: number };

/** Above this many queued bytes a client is "slow": we stop queuing patches and resend a snapshot later (ADR-0009). */
export const SLOW_CLIENT_BYTES = 256 * 1024;

/**
 * Per-connection view stream: owns `viewSeq`, sends patches when cheaper than the view,
 * snapshots on resync / slow client. Patches are shared between connections of the same viewer kind
 * when this stream is in sync with the previous broadcast (identity of `frame.base`).
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

  /** The welcome carries the first snapshot (viewSeq 0). `view` must be normalised (runtime.welcomeView). */
  welcome(view: View, serverTime: number, v: number): void {
    this.last = view;
    this.seq = 0;
    this.dirty = false;
    this.send({ t: "welcome", v, viewer: this.viewer, serverTime, viewSeq: 0, view });
  }

  update(frame: ViewFrame): void {
    if (this.wire.bufferedAmount > SLOW_CLIENT_BYTES) {
      this.dirty = true; // don't pile up patches on a slow client
      this.last = frame.view;
      return;
    }
    if (this.dirty || this.last === null) {
      this.snapshot(frame.view);
      return;
    }
    // Shared with every in-sync connection of this viewer kind, computed once by the runtime.
    const opsJson = frame.base !== null && this.last === frame.base && frame.opsJson !== null ? frame.opsJson : JSON.stringify(diff(this.last, frame.view));
    this.last = frame.view;
    if (opsJson === "[]") return;
    if (opsJson.length >= frame.viewJsonLength) {
      this.snapshot(frame.view);
      return;
    }
    this.seq += 1;
    // Hand-assembled to reuse the shared ops string; same shape as encode({ t: "patch", viewSeq, ops }).
    this.wire.send(`{"t":"patch","viewSeq":${this.seq},"ops":${opsJson}}`);
  }

  /** Called by a periodic sweep: a slow client that caught up gets a fresh snapshot. */
  flushIfCaughtUp(): void {
    if (this.dirty && this.last !== null && this.wire.bufferedAmount <= SLOW_CLIENT_BYTES) this.snapshot(this.last);
  }

  resync(view: View): void {
    this.snapshot(view);
  }

  private snapshot(view: View): void {
    this.last = view;
    this.dirty = false;
    this.seq += 1;
    this.send({ t: "snapshot", viewSeq: this.seq, view });
  }

  private send(m: ServerMessage): void {
    this.wire.send(encode(m));
  }
}
