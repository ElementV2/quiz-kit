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
 * What a reveal decided for one question of one round: kept for `question.regrade`, the speed tie-break and
 * the results export (answers per question). Replaced when the same question is revealed again in the round.
 */
export const QuestionRecord = z.strictObject({
  roundIndex: z.number().int().min(0),
  questionIndex: z.number().int().min(0),
  questionId: z.string(),
  mechanicId: z.string(),
  /** Final mechanic state at the reveal (validated by the mechanic's stateSchema when read back). */
  state: z.unknown(),
  openedAt: z.number().int().nullable(),
  windowMs: z.number().int().nullable(),
  /** Ledger entries written by this reveal (voided and rewritten by a regrade). */
  entryIds: z.array(z.string()),
  /** Live stakes applied at this reveal (kept so a regrade scores identically). */
  stakes: z.strictObject({ points: z.number().int().nullable(), multiplier: z.number().nullable() }).nullable().default(null),
  /** Verdicts forced by the control room for this question (`answer.verdict`): applied to every (re)scoring. */
  verdicts: z.array(z.strictObject({ participantId: z.string(), correct: z.boolean() })).default([]),
  /** Response time (ms after opening) of every right answer: the `speed` tie-break sums them. */
  correctMs: z.array(z.strictObject({ participantId: z.string(), ms: z.number().int().min(0) })).default([]),
});
export type QuestionRecord = z.infer<typeof QuestionRecord>;

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
  carry: z.strictObject({ id: z.string(), state: z.unknown(), revealed: z.boolean(), questionIndex: z.number().int().min(0) }).nullable(),
  /**
   * Round-spanning mechanics (`spansRounds`, ADR-0016), by mechanic id: the last state left by a `question.next`
   * (or changed between questions / rounds by its own actions), with its round. Never cleared by `round.start`.
   * Default: snapshots written before stay readable.
   */
  across: z.record(z.string(), z.strictObject({ state: z.unknown(), roundIndex: z.number().int().min(0) })).default({}),
  /** Ledger length at the last `round.start`: replaying a question only voids points of the current round. */
  roundLedgerStart: z.number().int().min(0),
  timer: TimerState.nullable(),
  openedAt: z.number().int().nullable(),
  lockedAt: z.number().int().nullable(),
  /** Answer window used by timeDecay: follows the timer actually armed; null without timer. */
  windowMs: z.number().int().nullable(),
  lastSeq: z.number().int(),
  /** Questions revealed at least once (run-down status). */
  played: z.array(z.string()),
  /** Manual layers currently TAKEN (on air), by layer id (doc 06). */
  layers: z.record(z.string(), z.boolean()),
  /** One record per revealed (round, question). Default: snapshots written before phase 3 stay readable. */
  history: z.array(QuestionRecord).default([]),
  /** Live stakes for one question (`question.setStakes`): the round / question index they apply to. */
  stakes: z.strictObject({ roundIndex: z.number().int(), questionIndex: z.number().int(), points: z.number().int().nullable(), multiplier: z.number().nullable() }).nullable().default(null),
  /**
   * Seq of the last event that changed the game document (`game.patch`, `question.edit` / `regrade` /
   * `replaceFromReserve`); 0 = as launched. Never reused (seqs are unique), so a stale studio copy is always seen.
   */
  gameVersion: z.number().int().min(0).default(0),
  /** Verdicts forced for the question on air (`answer.verdict`), moved into its record at the reveal. */
  verdicts: z.array(z.strictObject({ participantId: z.string(), correct: z.boolean() })).default([]),
  /** When the studio last sent the game to the live (`game.patch`): shown in the control room. */
  studioPatchedAt: z.number().nullable().default(null),
  /** The host may drive the question flow from their tablet (`host.setDrive`, HOST_DRIVE_ACTIONS). */
  hostDrives: z.boolean().default(false),
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
    across: {},
    roundLedgerStart: 0,
    timer: null,
    openedAt: null,
    lockedAt: null,
    windowMs: null,
    lastSeq: 0,
    played: [],
    layers: {},
    history: [],
    hostDrives: false,
    stakes: null,
    gameVersion: 0,
    studioPatchedAt: null,
    verdicts: [],
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
