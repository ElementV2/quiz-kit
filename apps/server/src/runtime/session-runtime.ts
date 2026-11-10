import { GameState, decide, project, replay, type Game, type Registry } from "@quiz/engine";
import type { Action, Actor, Session, View, Viewer } from "@quiz/schema";
import type { AckMessage } from "@quiz/protocol";
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

/** Receives the projected view of one viewer after every committed change. */
export type ViewSink = { readonly viewer: Viewer; update(view: View): void };

export type SubmitResult = AckMessage | { t: "ack"; key: null; ok: boolean; code?: string; reason?: string; eventSeq?: number };

const REJECTION_CACHE = 10_000;

/**
 * Identity of an intent for idempotency. `undo` is journaled with its resolved target (ADR-0010),
 * so only its type is compared.
 */
function fingerprint(actor: Actor, action: Action): string {
  return `${actor.role}|${actor.id ?? ""}|${action.type === "undo" ? "undo" : JSON.stringify(action)}`;
}

/**
 * One live session: the single writer (ADR-0003).
 * `submit` is fully synchronous — decide → append (fsync) → swap state → broadcast — so two intents can
 * never interleave in Node's event loop: the "serialized queue" is the event loop itself, with no await inside.
 */
export class SessionRuntime {
  private game: Game;
  /** key → seq + fingerprint of the intent it was used for. */
  private readonly accepted = new Map<string, { seq: number; fp: string }>();
  private readonly rejected = new Map<string, { code: string; reason: string; fp: string }>();
  private readonly sinks = new Set<ViewSink>();
  private cancelTimer: (() => void) | null = null;
  private armedTimerId: number | null = null;
  private closed = false;

  private readonly store: EventStore;
  private readonly registry: Registry;
  readonly session: Session;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Log;

  constructor(store: EventStore, registry: Registry, session: Session, clock: Clock, timers: Timers, log: Log) {
    this.store = store;
    this.registry = registry;
    this.session = session;
    this.clock = clock;
    this.timers = timers;
    this.log = log;
    const events = store.events(session.id);
    const raw = store.latestSnapshot(session.id);
    const snap = raw === null ? null : GameState.safeParse(raw.state);
    if (raw !== null && snap !== null && !snap.success) log.warn({ seq: raw.seq }, "snapshot invalide ignoré, rejeu complet");
    this.game = replay(session, events, registry, raw !== null && snap?.success === true ? { seq: raw.seq, state: snap.data } : undefined);
    for (const e of events) if (e.idempotencyKey !== null) this.accepted.set(e.idempotencyKey, { seq: e.seq, fp: fingerprint(e.actor, e.action) });
    log.info({ sessionId: session.id, events: events.length, lastSeq: this.game.state.lastSeq }, "session rechargée depuis le journal");
    this.armTimer();
  }

  get current(): Game {
    return this.game;
  }

  /** Resolves a seat viewer to the participant sitting there (for the actor stamp). */
  participantAtSeat(seat: number): string | null {
    return this.game.state.participants.find((p) => p.seat === seat)?.id ?? null;
  }

  submit(action: Action, actor: Actor, key: string | null): SubmitResult {
    if (this.closed) return this.reply(key, { ok: false, code: "not-ready", reason: "session fermée" });
    const fp = fingerprint(actor, action);
    if (key !== null) {
      // Replayed intent → same ack, never re-applied. A key reused for ANOTHER intent is refused explicitly:
      // acknowledging it would make that client believe an action passed that never ran.
      const seen = this.accepted.get(key);
      if (seen !== undefined) {
        return seen.fp === fp ? { t: "ack", key, ok: true, eventSeq: seen.seq } : { t: "ack", key, ok: false, code: "conflict", reason: "clé d'idempotence déjà utilisée pour une autre intention" };
      }
      const rej = this.rejected.get(key);
      if (rej !== undefined && rej.fp === fp) return { t: "ack", key, ok: false, code: rej.code, reason: rej.reason };
    }
    const r = decide(this.game, { action, actor, idempotencyKey: key }, this.clock(), this.registry);
    if (!r.ok) {
      if (key !== null) this.rememberRejection(key, r.error.code, r.error.message, fp);
      return this.reply(key, { ok: false, code: r.error.code, reason: r.error.message });
    }
    const { event, game } = r.value;
    try {
      this.store.append(this.session.id, event); // journal BEFORE anything else (non-negotiable #4)
    } catch (e) {
      this.log.error({ err: e, seq: event.seq, type: action.type }, "échec d'écriture du journal : action refusée");
      return this.reply(key, { ok: false, code: "server-error", reason: "journal indisponible" });
    }
    this.game = game;
    if (key !== null) this.accepted.set(key, { seq: event.seq, fp });
    if (action.type === "question.present") this.snapshot();
    this.armTimer();
    this.broadcast();
    return this.reply(key, { ok: true, eventSeq: event.seq });
  }

  view(viewer: Viewer): View {
    return project(this.game, viewer, this.registry);
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

  private reply(key: string | null, r: { ok: true; eventSeq: number } | { ok: false; code: string; reason: string }): SubmitResult {
    return key === null ? { t: "ack", key: null, ...r } : { t: "ack", key, ...r };
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

  /** Mutualised projections (ADR-0004): one projection per distinct viewer per change. */
  private broadcast(): void {
    const cache = new Map<string, View>();
    for (const sink of this.sinks) {
      const k = JSON.stringify(sink.viewer);
      let v = cache.get(k);
      if (v === undefined) {
        v = this.view(sink.viewer);
        cache.set(k, v);
      }
      try {
        sink.update(v);
      } catch (e) {
        this.log.warn({ err: e }, "client en erreur ignoré"); // one client never breaks the loop
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
    if (t === null || this.closed) return;
    this.armedTimerId = t.id;
    this.cancelTimer = this.timers.set(() => {
      this.cancelTimer = null;
      this.armedTimerId = null;
      const r = this.submit({ type: "timer.expired", timerId: t.id }, { role: "system" }, null);
      if (!r.ok) this.log.info({ timerId: t.id, reason: r.reason }, "expiration ignorée");
    }, Math.max(0, t.endsAt - this.clock()));
  }
}
