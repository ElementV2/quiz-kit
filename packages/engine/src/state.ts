import { z } from "zod";
import { GameDocument, Participant, Phase, ScoreEntry, SessionId, Team, type Question, type Round, type Session } from "@quiz/schema";

export const TimerState = z.strictObject({
  /** seq of the event that armed the timer; `timer.expired` must quote it (stale expirations are rejected). */
  id: z.number().int(),
  endsAt: z.number().int(),
  durationMs: z.number().int(),
  autoLock: z.boolean(),
});
export type TimerState = z.infer<typeof TimerState>;

/**
 * Full authoritative state. Never sent to clients as-is: use `project()`.
 * Schema-backed so persisted snapshots are validated when read back (CONVENTIONS: every boundary).
 */
export const GameState = z.strictObject({
  sessionId: SessionId,
  seed: z.number().int(),
  game: GameDocument,
  phase: Phase,
  roundIndex: z.number().int().nullable(),
  questionIndex: z.number().int().nullable(),
  participants: z.array(Participant),
  teams: z.array(Team),
  ledger: z.array(ScoreEntry),
  /** State of the current question's mechanic, validated by the mechanic's own stateSchema. */
  mechanic: z.strictObject({ id: z.string(), state: z.unknown() }).nullable(),
  /**
   * Final mechanic state of the previous question of the current round, handed to the next `init`
   * (round-level mechanics such as ladder). Cleared by `round.start`. Validated like `mechanic`.
   */
  carry: z.strictObject({ id: z.string(), state: z.unknown(), revealed: z.boolean() }).nullable(),
  timer: TimerState.nullable(),
  openedAt: z.number().int().nullable(),
  lockedAt: z.number().int().nullable(),
  /** Answer window used by timeDecay: follows the timer actually armed; null without timer. */
  windowMs: z.number().int().nullable(),
  lastSeq: z.number().int(),
});
export type GameState = z.infer<typeof GameState>;

export function initialState(session: Session): GameState {
  return {
    sessionId: session.id,
    seed: session.seed,
    game: session.game,
    phase: "lobby",
    roundIndex: null,
    questionIndex: null,
    participants: [],
    teams: [],
    ledger: [],
    mechanic: null,
    carry: null,
    timer: null,
    openedAt: null,
    lockedAt: null,
    windowMs: null,
    lastSeq: 0,
  };
}

export function currentRound(s: GameState): Round | null {
  return s.roundIndex === null ? null : (s.game.format.rounds[s.roundIndex] ?? null);
}

export function questionById(s: GameState, id: string): Question | null {
  return s.game.questions.find((q) => q.id === id) ?? null;
}

export function currentQuestion(s: GameState): Question | null {
  const round = currentRound(s);
  if (round === null || s.questionIndex === null) return null;
  const id = round.questions[s.questionIndex];
  return id === undefined ? null : questionById(s, id);
}

export function nextQuestion(s: GameState): Question | null {
  const round = currentRound(s);
  if (round === null) return null;
  const id = round.questions[s.questionIndex === null ? 0 : s.questionIndex + 1];
  return id === undefined ? null : questionById(s, id);
}

type Totals = { readonly participants: ReadonlyMap<string, number>; readonly teams: ReadonlyMap<string, number> };

/** One O(ledger) pass per ledger version, memoised: 500 projections reuse it (ADR-0004). Pure: keyed by identity. */
const totalsCache = new WeakMap<readonly ScoreEntry[], Totals>();

export function totals(s: GameState): Totals {
  const cached = totalsCache.get(s.ledger);
  if (cached !== undefined) return cached;
  const participants = new Map<string, number>();
  const teams = new Map<string, number>();
  for (const e of s.ledger) {
    if (e.voided) continue;
    if ("participantId" in e.target) participants.set(e.target.participantId, (participants.get(e.target.participantId) ?? 0) + e.delta);
    // Team at the time of scoring: moving a player never rewrites history.
    if (e.teamId !== null) teams.set(e.teamId, (teams.get(e.teamId) ?? 0) + e.delta);
  }
  const t = { participants, teams };
  totalsCache.set(s.ledger, t);
  return t;
}

/** Total of non-voided entries targeting this participant. */
export function participantTotal(s: GameState, participantId: string): number {
  return totals(s).participants.get(participantId) ?? 0;
}

/** Member entries (team at scoring time) + entries targeting the team. */
export function teamTotal(s: GameState, teamId: string): number {
  return totals(s).teams.get(teamId) ?? 0;
}
