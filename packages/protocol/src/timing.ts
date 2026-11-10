/**
 * Pure timing helpers shared by every client (browser, bots, k6). Randomness and time are parameters.
 */

/** Exponential backoff with full jitter, short cap to come back fast on a show LAN (doc 04). */
export function backoffDelay(attempt: number, random: number, baseMs = 100, capMs = 2000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random * ceiling);
}

export type ClockSample = { readonly offsetMs: number; readonly rttMs: number };

/**
 * NTP-style sample from a ping/pong round trip: the server stamped `serverTime` at ping,
 * the client sent the ping reply... here we use the classic 3-timestamp form:
 * client sends at t0 (clientTime), server time ts, client receives at t1.
 * offset = ts - (t0 + t1) / 2, rtt = t1 - t0. `serverNow ≈ clientNow + offset`.
 */
export function clockSample(t0: number, serverTime: number, t1: number): ClockSample {
  return { offsetMs: serverTime - (t0 + t1) / 2, rttMs: Math.max(0, t1 - t0) };
}

/** Sliding estimator: keeps the last `size` samples and trusts the ones with the lowest RTT. */
export class ClockEstimator {
  private readonly samples: ClockSample[] = [];
  private readonly size: number;
  constructor(size = 8) {
    this.size = size;
  }
  add(s: ClockSample): void {
    this.samples.push(s);
    if (this.samples.length > this.size) this.samples.shift();
  }
  /** Offset of the lowest-RTT third of samples (median), 0 before any sample. */
  get offsetMs(): number {
    if (this.samples.length === 0) return 0;
    const best = this.samples.toSorted((a, b) => a.rttMs - b.rttMs).slice(0, Math.max(1, Math.ceil(this.samples.length / 3)));
    const offsets = best.map((s) => s.offsetMs).toSorted((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)] ?? 0;
  }
  get rttMs(): number {
    const rtts = this.samples.map((s) => s.rttMs).toSorted((a, b) => a - b);
    return rtts[Math.floor(rtts.length / 2)] ?? 0;
  }
}

/** Client-side check of the per-connection view sequence (ADR-0009). */
export type SeqCheck = "next" | "gap" | "duplicate";
export function checkViewSeq(last: number, incoming: number): SeqCheck {
  if (incoming === last + 1) return "next";
  return incoming <= last ? "duplicate" : "gap";
}
