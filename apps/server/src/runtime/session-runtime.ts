import { GameState, decide, project, replay, type Game, type Registry } from "@quiz/engine";
import { diff, type AckMessage } from "@quiz/protocol";
import type { Action, Actor, Event, Session, View, Viewer } from "@quiz/schema";
import type { EventStore } from "../store/event-store.ts";

/** Ports injected so tests control time and timers (CONVENTIONS "D"). */
export type Clock = () => number;
/** `set` returns a cancel function. */
export type Timers = { set(fn: () => void, ms: number): () => void };
export const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void };

/**
 * One broadcast for one kind of viewer, shared by every connection with that viewer (ADR-0004):
 * the projection, its normalised form and the patch from the previous broadcast are computed once.
 */
export type ViewFrame = {
  readonly view: View;
  /** Previous broadcast view for this viewer kind (identity-compared by streams), or null. */
  readonly base: View | null;
  /** JSON of the RFC 6902 ops from `base` to `view`, or null when there is no base. */
  readonly opsJson: string | null;
  readonly viewJsonLength: number;
};

/** Receives the projected view of one viewer after every committed change. */
export type ViewSink = { readonly viewer: Viewer; update(frame: ViewFrame): void };

export type Ack =
  | { readonly t: "ack"; readonly key: string | null; readonly ok: true; readonly eventSeq: number }
  | { readonly t: "ack"; readonly key: string | null; readonly ok: false; readonly code: string; readonly reason: string };

export type JournalHealth = { readonly ok: boolean; readonly lastError: string | null; readonly lastErrorAt: number | null };

type QueuedIntent = { readonly action: Action; readonly actor: Actor; readonly key: string | null; readonly done: (ack: Ack) => void };

export type RuntimeOptions = {
  /** How a group commit is scheduled (default: setImmediate = after the current I/O turn). */
  readonly defer?: (fn: () => void) => void;
  /** Minimum time between two broadcasts; answers bursts are coalesced (default 0 = after every commit). */
  readonly broadcastIntervalMs?: number;
  /** Monotonic clock for coalescing (default performance.now): never the wall clock. */
  readonly monotonic?: () => number;
};

const REJECTION_CACHE = 10_000;
const TIMER_RETRY_MS = 1000;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON round-trip of a View is still that View minus undefined members
const normalize = (v: View): View => JSON.parse(JSON.stringify(v)) as View;

/**
 * Identity of an intent for idempotency: role + actor id + action. For a seat the actor id is left out: it is the
 * participant sitting there at resend time, which may have changed. An undo is journaled with its resolved target
 * (ADR-0010): a fingerprint rebuilt from the journal matches any undo under the same key.
 */
function fingerprint(actor: Actor, action: Action): string {
  const who = actor.role === "seat" ? "seat" : `${actor.role}:${actor.id ?? ""}`;
  if (action.type === "undo") return `${who}|undo|${action.targetSeq ?? "*"}`;
  return `${who}|${JSON.stringify(action)}`;
}
function journalFingerprint(actor: Actor, action: Action): string {
  return action.type === "undo" ? fingerprint(actor, action).replace(/\|undo\|[^|]*$/, "|undo|?") : fingerprint(actor, action);
}
function sameIntent(stored: string, fp: string): boolean {
  return stored === fp || (stored.endsWith("|undo|?") && fp.startsWith(stored.slice(0, -1)));
}

/**
 * One live session: the single writer (ADR-0003).
 * Intents are queued and flushed as a group commit: decide each (in order) → append all in one transaction →
 * swap state → ack → broadcast. `flush` is synchronous with no await inside, so two batches never interleave in
 * Node's event loop. Nothing after the commit can throw out of `flush`: a failing step is logged, the loop goes on.
 */
export class SessionRuntime {
  private game: Game;
  private readonly accepted = new Map<string, { seq: number; fp: string }>();
  private readonly rejected = new Map<string, { code: string; reason: string; fp: string }>();
  private readonly sinks = new Set<ViewSink>();
  private readonly lastFrames = new Map<string, { seq: number; view: View; viewer: Viewer }>();
  private cancelTimer: (() => void) | null = null;
  private armedTimerId: number | null = null;
  private closed = false;
  private journal: JournalHealth = { ok: true, lastError: null, lastErrorAt: null };
  /** Hot standby (doc 05): mirrors the primary's journal, refuses every intent, arms no timer, until promoted. */
  private standbyMode = false;

  private readonly store: EventStore;
  private readonly registry: Registry;
  readonly session: Session;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Log;
  private readonly defer: (fn: () => void) => void;
  private readonly broadcastIntervalMs: number;
  private readonly monotonic: () => number;
  private readonly queue: QueuedIntent[] = [];
  private flushScheduled = false;
  private broadcastPending = false;
  private lastBroadcastAt = Number.NEGATIVE_INFINITY;

  constructor(store: EventStore, registry: Registry, session: Session, clock: Clock, timers: Timers, log: Log, opts: RuntimeOptions = {}) {
    this.store = store;
    this.registry = registry;
    this.session = session;
    this.clock = clock;
    this.timers = timers;
    this.log = log;
    this.defer = opts.defer ?? ((fn) => setImmediate(fn));
    this.broadcastIntervalMs = opts.broadcastIntervalMs ?? 0;
    this.monotonic = opts.monotonic ?? (() => performance.now());
    const events = store.events(session.id);
    const raw = store.latestSnapshot(session.id);
    // A snapshot written before `gameVersion` existed would default it to 0 while a full replay gives the seq of
    // the last correction: a studio send checked on it could later replay differently. Full replay instead.
    const versioned = raw !== null && typeof raw.state === "object" && raw.state !== null && "gameVersion" in raw.state;
    const snap = raw === null || !versioned ? null : GameState.safeParse(raw.state);
    if (raw !== null && (snap === null || !snap.success)) log.warn({ seq: raw.seq }, "snapshot invalide ou ancien ignoré, rejeu complet");
    this.game = replay(session, events, registry, raw !== null && snap?.success === true ? { seq: raw.seq, state: snap.data } : undefined);
    for (const e of events) if (e.idempotencyKey !== null) this.accepted.set(e.idempotencyKey, { seq: e.seq, fp: journalFingerprint(e.actor, e.action) });
    log.info({ sessionId: session.id, events: events.length, lastSeq: this.game.state.lastSeq }, "session rechargée depuis le journal");
    this.armTimer();
  }

  get standby(): boolean {
    return this.standbyMode;
  }

  /** Standby on: intents refused, timers off. Off (promotion): this server takes the show from its journal. */
  setStandby(on: boolean): void {
    this.standbyMode = on;
    this.guard("timer", () => this.armTimer());
  }

  /**
   * Hot standby: appends events decided by the primary (journal first, like any batch), then folds them from the
   * current state and broadcasts. Events must follow the last one (seq contiguity), else nothing is applied.
   */
  replicate(events: readonly Event[]): { applied: number; skipped: number } {
    // Never once promoted: this server decides on its own from then on (review 4 I1).
    if (!this.standbyMode) throw new Error("réplication refusée : ce serveur n'est plus en secours");
    const last = this.game.events.at(-1)?.seq ?? 0;
    const fresh = events.filter((e) => e.seq > last);
    if (fresh.length === 0) return { applied: 0, skipped: 0 };
    const skippedBefore = this.game.skipped.length;
    if (fresh[0]?.seq !== last + 1 || fresh.some((e, i) => e.seq !== last + 1 + i)) throw new Error(`journal du principal non contigu après ${last}`);
    this.store.appendMany(this.session.id, fresh);
    this.game = replay(this.session, [...this.game.events, ...fresh], this.registry, last === 0 ? undefined : { seq: last, state: this.game.state });
    for (const e of fresh) if (e.idempotencyKey !== null) this.accepted.set(e.idempotencyKey, { seq: e.seq, fp: journalFingerprint(e.actor, e.action) });
    if (fresh.some((e) => e.action.type === "question.present")) this.guard("snapshot", () => this.snapshot());
    this.guard("timer", () => this.armTimer());
    this.guard("broadcast", () => this.scheduleBroadcast());
    // An event of the primary refused here = this build judges differently: the mirror diverges (review 4 I2).
    return { applied: fresh.length, skipped: this.game.skipped.length - skippedBefore };
  }

  /** Same event (seq, time, actor, action) as one of ours? Used by the standby to detect a forked journal. */
  sameEventAt(e: Event): boolean {
    const mine = this.game.events.find((x) => x.seq === e.seq);
    return mine !== undefined && mine.at === e.at && journalFingerprint(mine.actor, mine.action) === journalFingerprint(e.actor, e.action);
  }

  get current(): Game {
    return this.game;
  }

  get journalHealth(): JournalHealth {
    return this.journal;
  }

  /** Resolves a seat viewer to the participant sitting there (for the actor stamp). */
  participantAtSeat(seat: number): string | null {
    return this.game.state.participants.find((p) => p.seat === seat)?.id ?? null;
  }

  /** Processes one intent right now (tests, server timers). Same path as a batch of one. */
  submit(action: Action, actor: Actor, key: string | null): Ack {
    let result: Ack = reply(key, { ok: false, code: "server-error", reason: "non traité" });
    this.queue.push({ action, actor, key, done: (a) => (result = a) });
    this.flush();
    return result;
  }

  /** Several intents decided one after the other and journaled in ONE commit (one fsync), synchronously. */
  submitMany(items: readonly { readonly action: Action; readonly actor: Actor }[]): Ack[] {
    const acks: Ack[] = items.map(() => reply(null, { ok: false, code: "server-error", reason: "non traité" }));
    items.forEach((it, i) => this.queue.push({ action: it.action, actor: it.actor, key: null, done: (a) => (acks[i] = a) }));
    this.flush();
    return acks;
  }

  /**
   * Queues an intent for the next group commit (ADR-0008): every intent received in the same event-loop turn is
   * decided one after the other (single writer), journaled in ONE transaction (one fsync), then acked and broadcast
   * once. `done` is called after the commit — never before.
   */
  enqueue(action: Action, actor: Actor, key: string | null, done: (ack: Ack) => void): void {
    this.queue.push({ action, actor, key, done });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.defer(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    if (this.standbyMode) {
      for (const it of batch) it.done(reply(it.key, { ok: false, code: "not-ready", reason: "serveur de secours : la régie pilote le serveur principal" }));
      return;
    }
    if (this.closed) {
      for (const it of batch) it.done(reply(it.key, { ok: false, code: "not-ready", reason: "session fermée" }));
      return;
    }
    let game = this.game;
    const events: Event[] = [];
    /** `fresh` = decided in this batch (as opposed to a replayed answer for an already committed key). */
    const results: { it: QueuedIntent; ack: Ack | null; fp: string; fresh: boolean }[] = [];
    const inBatch = new Map<string, { index: number; fp: string }>();
    for (const it of batch) {
      const fp = fingerprint(it.actor, it.action);
      const early = this.replayed(it.key, fp, inBatch, results);
      if (early !== null) {
        // A duplicate of an intent decided earlier in THIS batch shares its fate (fresh), a replay of a committed key does not.
        results.push({ it, ack: early, fp, fresh: it.key !== null && inBatch.has(it.key) });
        continue;
      }
      let decided: ReturnType<typeof decide>;
      try {
        decided = decide(game, { action: it.action, actor: it.actor, idempotencyKey: it.key }, this.clock(), this.registry);
      } catch (e) {
        this.log.error({ err: e, type: it.action.type }, "bug moteur : action refusée");
        results.push({ it, ack: reply(it.key, { ok: false, code: "server-error", reason: "erreur interne" }), fp, fresh: true });
        continue;
      }
      if (it.key !== null) inBatch.set(it.key, { index: results.length, fp });
      if (!decided.ok) {
        results.push({ it, ack: reply(it.key, { ok: false, code: decided.error.code, reason: decided.error.message }), fp, fresh: true });
        continue;
      }
      game = decided.value.game;
      events.push(decided.value.event);
      results.push({ it, ack: reply(it.key, { ok: true, eventSeq: decided.value.event.seq }), fp, fresh: true });
    }
    if (events.length > 0) {
      try {
        this.store.appendMany(this.session.id, events); // journal BEFORE anything else (non-negotiable #4), one fsync
      } catch (e) {
        this.journal = { ok: false, lastError: e instanceof Error ? e.message : String(e), lastErrorAt: this.clock() };
        this.log.error({ err: e, count: events.length }, "échec d'écriture du journal : lot refusé");
        // Nothing decided in this batch happened (state untouched). Every FRESH decision — accepted or rejected, since a
        // rejection may depend on an accepted action of the same batch — becomes "retry later"; nothing is cached.
        // Replays of keys committed earlier keep their true ack.
        for (const r of results) if (r.fresh) r.ack = reply(r.it.key, { ok: false, code: "server-error", reason: "journal indisponible" });
        for (const r of results) this.deliver(r.it, r.ack);
        return;
      }
      // ── committed: from here on nothing may throw out of flush ──
      if (!this.journal.ok) this.journal = { ...this.journal, ok: true };
      this.game = game;
      for (const r of results) if (r.fresh && r.ack?.ok === true && r.it.key !== null) this.accepted.set(r.it.key, { seq: r.ack.eventSeq, fp: r.fp });
      if (events.some((e) => e.action.type === "question.present")) this.guard("snapshot", () => this.snapshot());
      this.guard("timer", () => this.armTimer());
      this.guard("broadcast", () => this.scheduleBroadcast());
    }
    // Rejections are cached only now: they were decided on a state that is now committed (or unchanged).
    for (const r of results) {
      if (r.fresh && r.ack !== null && !r.ack.ok && r.ack.code !== "server-error" && r.it.key !== null) this.rememberRejection(r.it.key, r.ack.code, r.ack.reason, r.fp);
    }
    for (const r of results) this.deliver(r.it, r.ack);
  }

  private deliver(it: QueuedIntent, ack: Ack | null): void {
    try {
      it.done(ack ?? reply(it.key, { ok: false, code: "server-error", reason: "non traité" }));
    } catch (e) {
      this.log.warn({ err: e }, "envoi d'ack en erreur ignoré");
    }
  }

  /** Same key seen before (journal, rejection cache, or earlier in this batch) → same answer, never re-applied. */
  private replayed(key: string | null, fp: string, inBatch: Map<string, { index: number; fp: string }>, results: readonly { ack: Ack | null }[]): Ack | null {
    if (key === null) return null;
    const conflict = reply(key, { ok: false, code: "conflict", reason: "clé d'idempotence déjà utilisée pour une autre intention" });
    const seen = this.accepted.get(key);
    // A key reused for ANOTHER intent is refused: acknowledging it would make that client believe an action passed.
    if (seen !== undefined) return sameIntent(seen.fp, fp) ? reply(key, { ok: true, eventSeq: seen.seq }) : conflict;
    const local = inBatch.get(key);
    if (local !== undefined) return local.fp === fp ? (results[local.index]?.ack ?? conflict) : conflict;
    const rej = this.rejected.get(key);
    if (rej !== undefined && rej.fp === fp) return reply(key, { ok: false, code: rej.code, reason: rej.reason });
    return null;
  }

  /** Coalesces broadcasts: at most one every `broadcastIntervalMs` (0 = immediately). Acks never wait for it. */
  private scheduleBroadcast(): void {
    if (this.broadcastIntervalMs === 0) {
      this.broadcast();
      return;
    }
    if (this.broadcastPending) return;
    // Monotonic clock: a wall-clock step back (Windows time sync) must never freeze the screens.
    const now = this.monotonic();
    const wait = Math.min(this.broadcastIntervalMs, this.lastBroadcastAt + this.broadcastIntervalMs - now);
    if (wait <= 0) {
      this.lastBroadcastAt = now;
      this.broadcast();
      return;
    }
    this.broadcastPending = true;
    this.timers.set(() => {
      this.broadcastPending = false;
      this.lastBroadcastAt = this.monotonic();
      this.guard("broadcast", () => this.broadcast());
    }, wait);
  }

  view(viewer: Viewer): View {
    return project(this.game, viewer, this.registry);
  }

  /** Normalised view for a new connection; reuses the last broadcast frame when still current. */
  welcomeView(viewer: Viewer): View {
    const k = JSON.stringify(viewer);
    const last = this.lastFrames.get(k);
    if (last !== undefined && last.seq === this.game.state.lastSeq) return last.view;
    const v = normalize(this.view(viewer));
    this.lastFrames.set(k, { seq: this.game.state.lastSeq, view: v, viewer });
    return v;
  }

  subscribe(sink: ViewSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  get clientCount(): number {
    return this.sinks.size;
  }

  close(): void {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.sinks.clear();
  }

  private guard(step: string, f: () => void): void {
    try {
      f();
    } catch (e) {
      this.log.error({ err: e, step }, "erreur après commit (l'action reste enregistrée, la boucle continue)");
    }
  }

  private rememberRejection(key: string, code: string, reason: string, fp: string): void {
    if (this.rejected.size >= REJECTION_CACHE) {
      const oldest = this.rejected.keys().next().value;
      if (oldest !== undefined) this.rejected.delete(oldest);
    }
    this.rejected.set(key, { code, reason, fp });
  }

  private snapshot(): void {
    try {
      this.store.saveSnapshot(this.session.id, this.game.state.lastSeq, this.game.state);
    } catch (e) {
      this.log.warn({ err: e }, "snapshot non écrit (non bloquant : le journal suffit)");
    }
  }

  /** One projection + one diff + one serialisation per viewer kind, shared by all its connections (ADR-0004). */
  private broadcast(): void {
    const groups = new Map<string, ViewSink[]>();
    for (const sink of this.sinks) {
      const k = JSON.stringify(sink.viewer);
      const g = groups.get(k);
      if (g === undefined) groups.set(k, [sink]);
      else g.push(sink);
    }
    const seq = this.game.state.lastSeq;
    for (const [k, sinks] of groups) {
      let frame: ViewFrame;
      try {
        const first = sinks[0];
        if (first === undefined) continue;
        const view = normalize(this.view(first.viewer));
        const prev = this.lastFrames.get(k);
        const base = prev?.view ?? null;
        frame = { view, base, opsJson: base === null ? null : JSON.stringify(diff(base, view)), viewJsonLength: JSON.stringify(view).length };
        this.lastFrames.set(k, { seq, view, viewer: first.viewer });
      } catch (e) {
        // Clients of this kind keep their previous view; the next change patches from it (same base).
        this.log.error({ err: e, viewer: k }, "projection en erreur : diffusion ignorée pour ce rôle");
        continue;
      }
      for (const sink of sinks) {
        try {
          sink.update(frame);
        } catch (e) {
          this.log.warn({ err: e }, "client en erreur ignoré"); // one client never breaks the loop
        }
      }
    }
  }

  /** (Re)arms the server timer from the state: deadlines are wall-clock, so this also works after a restart (ADR-0010). */
  private armTimer(): void {
    const t = this.game.state.timer;
    if (t?.id === this.armedTimerId && this.cancelTimer !== null) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.armedTimerId = null;
    // The standby never fires timers: the primary does, and its `timer.expired` arrives through the journal.
    if (t === null || this.closed || this.standbyMode) return;
    this.armedTimerId = t.id;
    this.cancelTimer = this.timers.set(() => this.fireTimer(t.id), Math.max(0, t.endsAt - this.clock()));
  }

  private fireTimer(timerId: number): void {
    this.cancelTimer = null;
    this.armedTimerId = null;
    try {
      const r = this.submit({ type: "timer.expired", timerId }, { role: "system" }, null);
      if (!r.ok && r.code === "server-error" && !this.journal.ok && !this.closed) {
        // Journal unavailable: keep trying, the auto-lock must not be lost.
        this.armedTimerId = timerId;
        this.cancelTimer = this.timers.set(() => this.fireTimer(timerId), TIMER_RETRY_MS);
      } else if (!r.ok) {
        this.log.info({ timerId, reason: r.reason }, "expiration ignorée");
      }
    } catch (e) {
      this.log.error({ err: e, timerId }, "erreur dans le timer serveur");
    }
  }
}

function reply(key: string | null, r: { ok: true; eventSeq: number } | { ok: false; code: string; reason: string }): Ack {
  return { t: "ack", key, ...r };
}

/** Narrow an Ack with a key to the wire message. */
export function toAckMessage(ack: Ack & { key: string }): AckMessage {
  return ack.ok ? { t: "ack", key: ack.key, ok: true, eventSeq: ack.eventSeq } : { t: "ack", key: ack.key, ok: false, code: ack.code, reason: ack.reason };
}
