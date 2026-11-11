import type { z } from "zod";
import type { Action, AnswerValue, MechanicView, ParticipantId, Phase, Question, ScoreTarget } from "@quiz/schema";
import type { Result, Rejection } from "./result.ts";
import type { Rng } from "./rng.ts";

/** Who looks at the mechanic: secrets depend on it (ADR-0004). */
export type Audience = "public" | "player" | "host" | "control";

export type MechanicEnv = { readonly at: number; readonly rng: Rng; readonly phase: Phase };

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
};

/**
 * Contract of a mechanic (doc 03, ADR-0002). The core owns the phase cycle; a mechanic owns
 * answer handling, judging and its projected view. Every mechanic must pass `mechanicContractSuite`.
 */
export interface Mechanic<C, S> {
  readonly id: string;
  readonly configSchema: z.ZodType<C>;
  readonly stateSchema: z.ZodType<S>;
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
