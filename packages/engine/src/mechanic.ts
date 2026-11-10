import type { z } from "zod";
import type { Action, AnswerValue, MechanicView, ParticipantId, Phase, Question } from "@quiz/schema";
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

/** Correctness decided by the mechanic; points are computed by `scoring.ts` from the round's ScoringRule. */
export type Judgement = {
  readonly participantId: ParticipantId;
  readonly outcome: "correct" | "wrong";
  /** Server time of the accepted answer, used by timeDecay. */
  readonly answeredAt: number;
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
  init(config: C, question: Question, env: MechanicEnv): Result<S, Rejection>;
  /** `answer.submit` while phase = open. */
  submit(state: S, participantId: ParticipantId, answer: AnswerValue, env: MechanicEnv): Result<S, Rejection>;
  /** Other mechanic-specific actions (`answer.judge`, later `buzz`…). Return null when not handled. */
  onAction(state: S, action: Action, env: MechanicEnv): Result<S, Rejection> | null;
  /** Called on `question.reveal`. */
  judge(state: S): readonly Judgement[];
  /** Accepted answer of a participant, for the player view. */
  answerOf(state: S, participantId: ParticipantId): readonly string[] | null;
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
