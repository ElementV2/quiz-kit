import type { z } from "zod";
import type { Action, AnswerValue, MechanicView, ParticipantId, Phase, Question, ScoreTarget, ScoringRule } from "@quiz/schema";
import type { Result, Rejection } from "./result.ts";
import type { Rng } from "./rng.ts";

/** Who looks at the mechanic: secrets depend on it (ADR-0004). */
export type Audience = "public" | "player" | "host" | "control";

export type MechanicEnv = {
  readonly at: number;
  readonly rng: Rng;
  readonly phase: Phase;
  /** When answers were locked (null while open): stream-delay windows (crowd-vote). */
  readonly lockedAt?: number | null | undefined;
  /**
   * Active participants, in registration order (chain: turn order, voters). Absent in a static check (studio round
   * issues): no player is known, the mechanic only checks the question and its settings.
   */
  readonly activePlayers?: readonly ParticipantId[] | undefined;
  /** Current round index (null before the first round; absent in a static check). */
  readonly roundIndex?: number | null | undefined;
};

export type ProjectEnv = {
  readonly audience: Audience;
  readonly phase: Phase;
  /** Set when audience = player. */
  readonly participantId: ParticipantId | null;
};

/**
 * Outcome decided by the mechanic, turned into ledger entries on `question.reveal`.
 * - `rule`: points computed by `scoring.ts` from the round's ScoringRule (choice, buzzer).
 * - `fixed`: points decided by the mechanic itself (poll-board bank, ladder gain), for a player or a team.
 *   A fixed judgement worth 0 writes nothing but still gives the players concerned their result.
 */
export type Judgement =
  | {
      readonly kind: "rule";
      readonly participantId: ParticipantId;
      readonly outcome: "correct" | "wrong";
      /** Server time of the accepted answer, used by timeDecay. */
      readonly answeredAt: number;
      /** Partial points (0..1] of the rule for a right answer (order / pairs / several answers / graded number). */
      readonly share?: number;
    }
  | {
      readonly kind: "fixed";
      readonly target: ScoreTarget;
      readonly outcome: "correct" | "wrong";
      readonly points: number;
    };

export type FixedJudgement = Extract<Judgement, { kind: "fixed" }>;

/**
 * What `init` knows about the round. `previous` is the final state of the previous question of the same
 * round (same mechanic), `revealed` telling whether it was revealed or skipped. Round-level mechanics
 * (ladder) carry their progression through it; per-question mechanics ignore it.
 */
export type RoundContext<S> = {
  readonly previous: { readonly state: S; readonly revealed: boolean; readonly questionIndex: number } | null;
  /** Index of the question being presented in the round. */
  readonly questionIndex: number;
  /** Questions left in the round after this one. */
  readonly questionsLeft: number;
  /** Every question of the round, in round order (board: the grid is built from them). */
  readonly questions: readonly Question[];
  /** Index of the round in the format (absent in a static check). */
  readonly roundIndex?: number | undefined;
  /**
   * Round-spanning mechanics (`spansRounds`, ADR-0016): the last state this mechanic left in an EARLIER round
   * (`GameState.across`), null the first time. Only read when `previous` is null (first question of the round).
   */
  readonly earlier?: { readonly state: S; readonly roundIndex: number } | null | undefined;
};

/**
 * Contract of a mechanic (doc 03, ADR-0002). The core owns the phase cycle; a mechanic owns
 * answer handling, judging and its projected view. Every mechanic must pass `mechanicContractSuite`.
 */
export interface Mechanic<C, S> {
  readonly id: string;
  readonly configSchema: z.ZodType<C>;
  readonly stateSchema: z.ZodType<S>;
  /**
   * Questions are played in any order (board): `question.present` without index takes the first question
   * `init` accepts, and only `endsRound` ends the round (not the last index).
   */
  readonly freeOrder?: boolean;
  /** The question media is the secret (reveal-image): never sent to players in the base view. */
  readonly hidesPromptMedia?: boolean;
  /**
   * Router round (« mixte », ADR-0015): the mechanic that plays this question and its settings. A router never
   * goes on air itself; every engine path resolves it through `playedBy` (route.ts).
   */
  route?(config: C, question: Question): { readonly id: string; readonly config: unknown; readonly scoring?: ScoringRule };
  /**
   * Live settings change (`game.patch`) while a question is on air: the settings that cannot change any point
   * already decided (what is shown at the reveal, steal allowed, strikes allowed…) apply to it at once. Absent:
   * the question keeps the settings it was presented with (they apply from the next one).
   */
  reconfigure?(state: S, config: C, question: Question): S;
  /** Called on `question.present`. Rejects question kinds it cannot run. */
  init(config: C, question: Question, env: MechanicEnv, round: RoundContext<S>): Result<S, Rejection>;
  /** `answer.submit` while phase = open. */
  submit(state: S, participantId: ParticipantId, answer: AnswerValue, env: MechanicEnv): Result<S, Rejection>;
  /**
   * Mechanic-specific actions (`answer.judge`, `buzz`, `element.reveal`, `joker.use`…). The core has
   * checked roles, actor identity and referenced teams / players; the mechanic checks `env.phase`.
   * Return null when not handled (→ `unsupported`).
   */
  onAction(state: S, action: Action, env: MechanicEnv): Result<S, Rejection> | null;
  /** Called on `question.reveal`, and for players' results afterwards: must not depend on the phase. */
  judge(state: S): readonly Judgement[];
  /** Asked on `question.next`: true ends the round now (ladder lost, stopped or top step reached). */
  endsRound(state: S, phase: Phase): boolean;
  /**
   * Called on the `question.next` that ends the round: points not written by a reveal (ladder ended by a
   * skipped last question or a stop without reveal). Written to the ledger like reveal points.
   */
  closeRound(state: S, phase: Phase): readonly FixedJudgement[];
  /** Accepted answer of a participant, for the player view. */
  answerOf(state: S, participantId: ParticipantId): readonly string[] | null;
  /** Drops a removed participant's answer (ids may be reused later). */
  removeParticipant(state: S, participantId: ParticipantId): S;
  /** All accepted answers, for the control view. */
  answers(state: S): readonly { participantId: ParticipantId; optionIds: readonly string[]; at: number }[];
  project(state: S, env: ProjectEnv): MechanicView;
  /**
   * View shown between questions of the round (phase `idle`, no question on): the board grid while control
   * picks the next cell. `previous` = final state of the last question played in the round, if any.
   */
  projectIdle?(config: C, questions: readonly Question[], previous: S | null, env: ProjectEnv): MechanicView;
  /**
   * `question.regrade`: the same answers judged against the corrected question (same answer kind).
   * Absent or null: this mechanic cannot be regraded (judged by a human, round-level progression…).
   */
  regrade?(state: S, question: Question): Result<S, Rejection> | null;
  /**
   * `question.next` on a question that was NOT revealed: points the mechanic still wants written (board: a cell
   * judged right then skipped without reveal keeps its value). Absent: nothing is written (default).
   */
  onSkip?(state: S): readonly FixedJudgement[];
  /**
   * Points are decided by the mechanic (fixed judgements only: board, poll-board, allocation, hints…): live
   * stakes can multiply them, never replace them with a points value.
   */
  readonly ownPoints?: boolean;
  /** Live stakes make no sense (ladder: the gain of the whole climb is at stake on every question). */
  readonly noStakes?: boolean;
  /** Smaller state kept in the reveal history (must judge / regrade / project identically). Absent: as is. */
  compact?(state: S): S;
  /**
   * Round-spanning mechanic (chain, ADR-0016): the state it leaves at each `question.next` outlives the round
   * (`GameState.across`, never cleared by `round.start`). The next round it plays starts from it (`RoundContext.earlier`);
   * while no question is on air, its round-spanning actions (`chain.*`) go to that state (`onAction` with phase idle,
   * round.end) and it is projected (idle, round.end, game.end).
   */
  readonly spansRounds?: boolean;
  /** Participants an accepted action eliminates (chain vote): the core sets their status to `eliminated`. */
  eliminates?(before: S, after: S): readonly ParticipantId[];
}

/** Type-erased mechanic stored in the registry. */
export type AnyMechanic = Mechanic<unknown, unknown>;

export type Registry = {
  get(id: string): AnyMechanic | null;
  ids(): readonly string[];
};

export function createRegistry(mechanics: readonly AnyMechanic[]): Registry {
  const map = new Map<string, AnyMechanic>();
  for (const m of mechanics) {
    if (map.has(m.id)) throw new Error(`mechanic registered twice: ${m.id}`);
    map.set(m.id, m);
  }
  return { get: (id) => map.get(id) ?? null, ids: () => [...map.keys()] };
}

/** Erases the generic parameters; safe because the registry always pairs a state with its own mechanic. */
export function defineMechanic<C, S>(m: Mechanic<C, S>): AnyMechanic {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- generic erasure: a state is only ever handed back to the mechanic that produced it (see Registry)
  return m as unknown as AnyMechanic;
}
