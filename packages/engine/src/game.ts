import { isAllowed, isControlDecision, type Action, type Actor, type Event, type Session } from "@quiz/schema";
import type { Registry } from "./mechanic.ts";
import { reduce } from "./reduce.ts";
import { err, ok, type Rejection, type Result } from "./result.ts";
import { createRng } from "./rng.ts";
import { initialState, type GameState } from "./state.ts";

export type Skipped = { readonly seq: number; readonly type: string; readonly reason: string };

/**
 * Pure aggregate: the journal in memory + the state it folds to (ADR-0003, ADR-0010).
 * The server owns one Game per session and replaces it only after the event is committed.
 */
export type Game = {
  readonly session: Session;
  readonly events: readonly Event[];
  /** seq → seq of the undo that cancels it (cancelled undos are themselves keys). */
  readonly cancelledBy: ReadonlyMap<number, number>;
  readonly state: GameState;
  /** Events ignored at the last replay because they became invalid after an undo. */
  readonly skipped: readonly Skipped[];
};

export type Intent = { readonly action: Action; readonly actor: Actor; readonly idempotencyKey: string | null };

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
 */
export function decide(g: Game, intent: Intent, at: number, registry: Registry): Result<{ event: Event; game: Game }, Rejection> {
  const seq = nextSeq(g);
  const event: Event = { seq, at, actor: intent.actor, action: intent.action, idempotencyKey: intent.idempotencyKey };
  if (intent.action.type === "undo") {
    if (!isAllowed(intent.actor.role, "undo")) return err("forbidden", `le rôle ${intent.actor.role} ne peut pas annuler`);
    const target = undoTarget(g.events, g.cancelledBy, intent.action.targetSeq);
    if (!target.ok) return target;
    const cancelledBy = applyUndo(g.cancelledBy, g.events, target.value, seq);
    const events = [...g.events, event];
    const folded = fold(g.session, events, cancelledBy, registry);
    return ok({ event, game: { session: g.session, events, cancelledBy, ...folded } });
  }
  const r = reduce(g.state, intent.action, { at, seq, actor: intent.actor, rng: createRng(g.session.seed, seq) }, registry);
  if (!r.ok) return r;
  return ok({ event, game: { ...g, events: [...g.events, event], state: r.value } });
}

/** Rebuilds a game from its journal (crash recovery, ADR-0003). Deterministic. */
export function replay(session: Session, events: readonly Event[], registry: Registry): Game {
  let cancelledBy: ReadonlyMap<number, number> = new Map();
  for (const e of events) {
    if (e.action.type !== "undo") continue;
    const target = undoTarget(events.filter((x) => x.seq < e.seq), cancelledBy, e.action.targetSeq);
    if (target.ok) cancelledBy = applyUndo(cancelledBy, events, target.value, e.seq);
  }
  return { session, events: [...events], cancelledBy, ...fold(session, events, cancelledBy, registry) };
}

function fold(session: Session, events: readonly Event[], cancelledBy: ReadonlyMap<number, number>, registry: Registry): { state: GameState; skipped: Skipped[] } {
  let state = initialState(session);
  const skipped: Skipped[] = [];
  for (const e of events) {
    if (e.action.type === "undo") {
      state = { ...state, lastSeq: e.seq };
      continue;
    }
    if (cancelledBy.has(e.seq)) continue;
    const r = reduce(state, e.action, { at: e.at, seq: e.seq, actor: e.actor, rng: createRng(session.seed, e.seq) }, registry);
    if (r.ok) state = r.value;
    else skipped.push({ seq: e.seq, type: e.action.type, reason: r.error.message });
  }
  return { state, skipped };
}

function isActive(seq: number, cancelledBy: ReadonlyMap<number, number>): boolean {
  return !cancelledBy.has(seq);
}

/**
 * Default target: the latest active control decision (never a player answer). An explicit target may
 * be any active event, including an active undo (→ redo).
 */
function undoTarget(events: readonly Event[], cancelledBy: ReadonlyMap<number, number>, explicit: number | undefined): Result<number, Rejection> {
  if (explicit !== undefined) {
    const e = events.find((x) => x.seq === explicit);
    if (e === undefined) return err("not-found", `événement ${explicit} inconnu`);
    if (!isActive(explicit, cancelledBy)) return err("conflict", `événement ${explicit} déjà annulé`);
    return ok(explicit);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && e.action.type !== "undo" && isControlDecision(e.action.type) && isActive(e.seq, cancelledBy)) return ok(e.seq);
  }
  return err("not-found", "rien à annuler");
}

/** Cancelling an undo restores what it had cancelled (redo). */
function applyUndo(cancelledBy: ReadonlyMap<number, number>, events: readonly Event[], target: number, undoSeq: number): Map<number, number> {
  const next = new Map(cancelledBy);
  const targetEvent = events.find((x) => x.seq === target);
  if (targetEvent?.action.type === "undo") {
    for (const [seq, by] of next) if (by === target) next.delete(seq);
  }
  next.set(target, undoSeq);
  return next;
}
