import { normalizeAnswer } from "@quiz/engine";
import type { MechanicView } from "@quiz/schema";
import type { SessionRuntime, Timers } from "../runtime/session-runtime.ts";

/**
 * Chat → `crowd.tally` (doc 04 chat inputs). Every platform connector (Twitch, YouTube) pushes raw messages here.
 * A message counts as a vote when the question on air is a `crowd-vote` and the text names an option:
 * its letter (`A`, `!b`, `c)`), its number (`1`…) or its label. Anti-spam: one vote per viewer per
 * `minIntervalMs`; at most `maxPerFlush` votes per batch. Votes are batched every `flushMs` into ONE journaled
 * action (a busy chat never writes one event per message).
 */

export type ChatMessage = { readonly platform: "tw" | "yt"; readonly userId: string; readonly text: string };

export type IngestStats = { received: number; votes: number; ignored: number; rateLimited: number; batches: number };

const LETTERS = "abcdefghijkl";

/** Option id a chat text votes for, or null. Pure. */
export function voteOf(text: string, options: readonly { id: string; label: string }[]): string | null {
  const t = text.trim().toLowerCase().replace(/^!\s*/, "");
  const m = /^([a-l]|1[0-2]|[1-9])(?:$|[\s).:!,-])/.exec(t);
  if (m !== null) {
    const k = m[1] ?? "";
    const index = /\d/.test(k) ? Number(k) - 1 : LETTERS.indexOf(k);
    return options[index]?.id ?? null;
  }
  const n = normalizeAnswer(t);
  return n.length === 0 ? null : (options.find((o) => normalizeAnswer(o.label) === n)?.id ?? null);
}

const USER_ID = /^[0-9A-Za-z_-]{1,64}$/;

export class ChatIngest {
  readonly stats: IngestStats = { received: 0, votes: 0, ignored: 0, rateLimited: 0, batches: 0 };
  private readonly lastVoteAt = new Map<string, number>();
  private pending = new Map<string, string>();
  private cancelFlush: (() => void) | null = null;
  private readonly runtime: () => SessionRuntime;
  private readonly timers: Timers;
  private readonly clock: () => number;
  private readonly flushMs: number;
  private readonly minIntervalMs: number;
  private readonly maxPerFlush: number;

  constructor(opts: { runtime: () => SessionRuntime; timers: Timers; clock: () => number; flushMs?: number; minIntervalMs?: number; maxPerFlush?: number }) {
    this.runtime = opts.runtime;
    this.timers = opts.timers;
    this.clock = opts.clock;
    this.flushMs = opts.flushMs ?? 300;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.maxPerFlush = opts.maxPerFlush ?? 1000;
  }

  /** Options of the crowd vote on air (light: called per message, the view is cached by the runtime per seq). */
  private options(): readonly { id: string; label: string }[] | null {
    const v = this.runtime().welcomeView({ role: "output", scene: "program" }); // cached per seq: not one projection per message
    const m: MechanicView | null = v.mechanic;
    return m?.mechanic === "crowd-vote" && (v.phase === "open" || v.phase === "locked" || v.phase === "judging") ? m.options : null;
  }

  push(msg: ChatMessage): void {
    this.stats.received++;
    if (!USER_ID.test(msg.userId)) {
      this.stats.ignored++;
      return;
    }
    const options = this.options();
    const optionId = options === null ? null : voteOf(msg.text, options);
    if (optionId === null) {
      this.stats.ignored++;
      return;
    }
    const userId = `${msg.platform}:${msg.userId}`;
    const now = this.clock();
    const last = this.lastVoteAt.get(userId);
    if (last !== undefined && now - last < this.minIntervalMs) {
      this.stats.rateLimited++;
      return;
    }
    if (this.pending.size >= this.maxPerFlush && !this.pending.has(userId)) {
      this.stats.rateLimited++;
      return;
    }
    this.lastVoteAt.set(userId, now);
    this.pending.set(userId, optionId);
    this.stats.votes++;
    this.cancelFlush ??= this.timers.set(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    if (this.pending.size === 0) return;
    const votes = [...this.pending].map(([userId, optionId]) => ({ userId, optionId }));
    this.pending = new Map();
    this.stats.batches++;
    // A refusal (voting closed after the stream delay) is normal: the engine decides, nothing to do.
    this.runtime().enqueue({ type: "crowd.tally", votes }, { role: "system" }, null, () => undefined);
    if (this.lastVoteAt.size > 200_000) this.lastVoteAt.clear(); // memory bound on very long shows
  }

  close(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    this.pending.clear();
  }
}
