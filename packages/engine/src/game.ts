import { isAllowed, isNeverUndone, isUndoableByDefault, type Action, type Actor, type Event, type Session, ROLE_LABEL_FR } from "@quiz/schema";
import type { Registry } from "./mechanic.ts";
import { reduce } from "./reduce.ts";
import { err, ok, type Rejection, type Result } from "./result.ts";
import { createRng } from "./rng.ts";
import { GameState, initialState } from "./state.ts";

export type Skipped = { readonly seq: number; readonly type: string; readonly reason: string };

/**
 * Pure aggregate: the journal in memory + the state it folds to (ADR-0003, ADR-0010).
 * The server owns one Game per session and replaces it only after the event is committed.
 */
export type Game = {
  readonly session: Session;
  readonly events: readonly Event[];
  /** Cancelled seq → seq of the active undo that cancels it. Undos can themselves be cancelled (redo). */
  readonly cancelledBy: ReadonlyMap<number, number>;
  readonly state: GameState;
  /** Events without effect: they became invalid after an undo (shown to control). */
  readonly skipped: readonly Skipped[];
};

export type Intent = { readonly action: Action; readonly actor: Actor; readonly idempotencyKey: string | null };

/** A persisted checkpoint: the state right after event `seq` (ADR-0003). */
export type Snapshot = { readonly seq: number; readonly state: GameState };

export class CorruptJournalError extends Error {}

export function createGame(session: Session): Game {
  return { session, events: [], cancelledBy: new Map(), state: initialState(session), skipped: [] };
}

/** Next journal seq. */
export function nextSeq(g: Game): number {
  return (g.events.at(-1)?.seq ?? 0) + 1;
}

/**
 * Validates an intent against the current game. On success returns the event to journal and the
 * resulting game. Nothing is mutated: if the journal write fails, the caller simply drops the result.
 * An `undo` is journaled with its resolved `targetSeq`, so replay never has to guess (ADR-0010).
 */
export function decide(g: Game, intent: Intent, at: number, registry: Registry): Result<{ event: Event; game: Game }, Rejection> {
  const seq = nextSeq(g);
  if (intent.action.type === "undo") {
    if (!isAllowed(intent.actor.role, "undo")) return err("forbidden", `${ROLE_LABEL_FR[intent.actor.role]} ne peut pas annuler`);
    const target = undoTarget(g, intent.action.targetSeq);
    if (!target.ok) return target;
    const event: Event = { seq, at, actor: intent.actor, action: { type: "undo", targetSeq: target.value }, idempotencyKey: intent.idempotencyKey };
    const events = [...g.events, event];
    const cancelledBy = computeCancelled(events);
    return ok({ event, game: { session: g.session, events, cancelledBy, ...fold(g.session, events, cancelledBy, registry) } });
  }
  const event: Event = { seq, at, actor: intent.actor, action: intent.action, idempotencyKey: intent.idempotencyKey };
  const r = reduce(g.state, intent.action, { at, seq, actor: intent.actor, rng: createRng(g.session.seed, seq) }, registry);
  if (!r.ok) return r;
  return ok({ event, game: { ...g, events: [...g.events, event], state: r.value } });
}

/**
 * Rebuilds a game from its journal (crash recovery, ADR-0003). Deterministic.
 * With a valid snapshot, folds only the events after it — unless an undo after the snapshot changed
 * the fate of an event before it, in which case it replays everything.
 * Throws CorruptJournalError if seqs are not 1, 2, 3… (never silently play a damaged journal).
 */
export function replay(session: Session, events: readonly Event[], registry: Registry, snapshot?: Snapshot): Game {
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1) throw new CorruptJournalError(`journal non contigu : seq ${e.seq} en position ${i + 1}`);
  }
  const cancelledBy = computeCancelled(events);
  const usable = snapshot !== undefined && isUsableSnapshot(snapshot, events, cancelledBy, registry);
  const folded = usable
    ? fold(session, events.filter((e) => e.seq > snapshot.seq), cancelledBy, registry, snapshot.state)
    : fold(session, events, cancelledBy, registry);
  return { session, events: [...events], cancelledBy, ...folded };
}

function isUsableSnapshot(snap: Snapshot, events: readonly Event[], cancelledBy: ReadonlyMap<number, number>, registry: Registry): boolean {
  if (snap.seq > events.length || snap.state.lastSeq > snap.seq) return false;
  // An undo after the snapshot that cancels (or restores) something before it invalidates the snapshot.
  for (const e of events) {
    if (e.seq > snap.seq && e.action.type === "undo" && (e.action.targetSeq ?? 0) <= snap.seq) return false;
  }
  for (const [target, by] of cancelledBy) if (target <= snap.seq && by > snap.seq) return false;
  // Shape first (an older snapshot may lack fields), then mechanic states with their own schemas (boundary: DB read).
  const parsed = GameState.safeParse(snap.state);
  if (!parsed.success) return false;
  const across = Object.entries(parsed.data.across).map(([id, a]) => ({ id, state: a.state }));
  for (const m of [parsed.data.mechanic, parsed.data.carry, ...across]) {
    if (m === null) continue;
    const mech = registry.get(m.id);
    if (mech === null || !mech.stateSchema.safeParse(m.state).success) return false;
  }
  return true;
}

/**
 * An event is active iff no ACTIVE undo targets it. Undos only target earlier events, so a single
 * pass from newest to oldest settles every level of undo / redo / re-undo.
 */
function computeCancelled(events: readonly Event[]): Map<number, number> {
  const cancelled = new Map<number, number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined || e.action.type !== "undo" || cancelled.has(e.seq)) continue;
    const target = e.action.targetSeq;
    if (target !== undefined && target < e.seq && !cancelled.has(target)) cancelled.set(target, e.seq);
  }
  return cancelled;
}

function fold(session: Session, events: readonly Event[], cancelledBy: ReadonlyMap<number, number>, registry: Registry, from: GameState = initialState(session)): { state: GameState; skipped: Skipped[] } {
  const bySeq = new Map(events.map((x) => [x.seq, x]));
  let state = from;
  const skipped: Skipped[] = [];
  for (const e of events) {
    if (e.action.type === "undo") {
      if (e.action.targetSeq === undefined || e.action.targetSeq >= e.seq) skipped.push({ seq: e.seq, type: "undo", reason: "undo sans cible valide" });
      // An undo that reopens answers whose timer already ran out reopens them WITHOUT a timer: else the expired
      // timer closes them again at once and the control room can never go back (« +10 s » restarts one).
      const target = e.action.targetSeq === undefined ? undefined : bySeq.get(e.action.targetSeq);
      const reopening = !cancelledBy.has(e.seq) && (target?.action.type === "question.lock" || target?.action.type === "timer.expired");
      const expired = reopening && state.timer !== null && state.timer.endsAt <= e.at && state.phase === "open";
      state = { ...state, lastSeq: e.seq, ...(expired ? { timer: null } : {}) };
      continue;
    }
    if (cancelledBy.has(e.seq)) continue;
    const r = reduce(state, e.action, { at: e.at, seq: e.seq, actor: e.actor, rng: createRng(session.seed, e.seq) }, registry);
    if (r.ok) state = r.value;
    else skipped.push({ seq: e.seq, type: e.action.type, reason: r.error.message });
  }
  return { state, skipped };
}

/**
 * Default target: the latest event that is active, has an effect (not skipped) and is undoable by
 * default (never a player answer). An explicit target may be any such event, including an undo (→ redo).
 */
function undoTarget(g: Game, explicit: number | undefined): Result<number, Rejection> {
  const skipped = new Set(g.skipped.map((s) => s.seq));
  const hasEffect = (seq: number): boolean => !g.cancelledBy.has(seq) && !skipped.has(seq);
  // A studio send (`game.patch`) was checked against the state it was sent on: undoing (or redoing) anything
  // before it would replay it on another state and could drop it silently. Undo stops at the last one.
  let barrier = 0;
  for (const e of g.events) if (e.action.type === "game.patch" && hasEffect(e.seq)) barrier = e.seq;
  const crosses = (e: Event): boolean => e.seq < barrier || (e.action.type === "undo" && (e.action.targetSeq ?? 0) < barrier);
  const barrierMsg = "impossible d'annuler une action d'avant le dernier envoi du studio : corriger à la main (scores, joueurs, réponse)";
  if (explicit !== undefined) {
    const e = g.events.find((x) => x.seq === explicit);
    if (e === undefined) return err("not-found", `événement ${explicit} inconnu`);
    if (g.cancelledBy.has(explicit)) return err("conflict", `événement ${explicit} déjà annulé`);
    if (skipped.has(explicit)) return err("conflict", `événement ${explicit} déjà sans effet`);
    if (isNeverUndone(e.action.type)) return err("forbidden", "ce réglage ne s'annule pas : envoyer le réglage inverse");
    if (crosses(e)) return err("forbidden", barrierMsg);
    return ok(explicit);
  }
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e === undefined) continue;
    if (e.seq < barrier) return err("forbidden", barrierMsg);
    if (isUndoableByDefault(e.action.type) && hasEffect(e.seq)) return ok(e.seq);
  }
  return err("not-found", "rien à annuler");
}
