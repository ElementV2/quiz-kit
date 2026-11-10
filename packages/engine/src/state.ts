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
  timer: TimerState.nullable(),
  openedAt: z.number().int().nullable(),
  lockedAt: z.number().int().nullable(),
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
    timer: null,
    openedAt: null,
    lockedAt: null,
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

/** Total of non-voided entries for a participant, plus their team entries are NOT included (team totals are separate). */
export function participantTotal(s: GameState, participantId: string): number {
  let total = 0;
  for (const e of s.ledger) if (!e.voided && "participantId" in e.target && e.target.participantId === participantId) total += e.delta;
  return total;
}

export function teamTotal(s: GameState, teamId: string): number {
  let total = 0;
  for (const e of s.ledger) {
    if (e.voided) continue;
    if ("teamId" in e.target && e.target.teamId === teamId) total += e.delta;
    else if ("participantId" in e.target) {
      const pid = e.target.participantId;
      if (s.participants.some((p) => p.id === pid && p.teamId === teamId)) total += e.delta;
    }
  }
  return total;
}
