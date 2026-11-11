import { z } from "zod";
import { ParticipantId, type Phase } from "@quiz/schema";
import { err, ok, type Rejection, type Result } from "../../result.ts";

/**
 * Helpers shared by the "one answer per player" mechanics (text, number, order, pairs, pin, allocation,
 * hints, reveal-image). An answer is kept in its text form (`PlayerView.myAnswer`, `ControlView.answers`).
 */

export const StoredAnswer = z.strictObject({
  participantId: ParticipantId,
  /** Text form (see `PlayerView.myAnswer`). */
  value: z.array(z.string().max(200)),
  at: z.number().int(),
});
export type StoredAnswer = z.infer<typeof StoredAnswer>;

export const Overrule = z.strictObject({ participantId: ParticipantId, correct: z.boolean() });
export type Overrule = z.infer<typeof Overrule>;

/** Replaces (or refuses to replace) a player's answer. */
export function storeAnswer<S extends { readonly answers: readonly StoredAnswer[]; readonly allowChange: boolean }>(
  s: S,
  participantId: string,
  value: readonly string[],
  at: number,
): Result<S, Rejection> {
  const existing = s.answers.some((a) => a.participantId === participantId);
  if (existing && !s.allowChange) return err("conflict", "réponse déjà enregistrée");
  return ok({ ...s, answers: [...s.answers.filter((a) => a.participantId !== participantId), { participantId, value: [...value], at }] });
}

export const answerOfStored = (answers: readonly StoredAnswer[], participantId: string): readonly string[] | null =>
  answers.find((a) => a.participantId === participantId)?.value ?? null;

export const answersOfStored = (answers: readonly StoredAnswer[]) => answers.map((a) => ({ participantId: a.participantId, optionIds: a.value, at: a.at }));

const JUDGEABLE: ReadonlySet<Phase> = new Set(["open", "locked", "judging"]);

/** Operator overrule of an automatic verdict (`answer.judge { participantId, correct }`), before the reveal. */
export function overrule<S extends { readonly answers: readonly StoredAnswer[]; readonly overrules: readonly Overrule[] }>(
  s: S,
  participantId: string | undefined,
  correct: boolean,
  phase: Phase,
): Result<S, Rejection> {
  if (!JUDGEABLE.has(phase)) return err("wrong-phase", "on ne corrige qu'avant la révélation (ensuite : question.regrade)");
  if (participantId === undefined) return err("invalid", "préciser le joueur (participantId)");
  if (!s.answers.some((a) => a.participantId === participantId)) return err("not-found", "ce joueur n'a pas répondu");
  return ok({ ...s, overrules: [...s.overrules.filter((o) => o.participantId !== participantId), { participantId, correct }] });
}

/** Overruled verdict if any, else the automatic one. */
export const verdict = (overrules: readonly Overrule[], participantId: string, auto: boolean): boolean =>
  overrules.find((o) => o.participantId === participantId)?.correct ?? auto;

export const isPrivileged = (audience: string): boolean => audience === "host" || audience === "control";

/** Distribution / pins / ranking: host and control from `locked`, everyone once revealed. */
export const showsResults = (audience: string, phase: Phase): boolean =>
  phase === "revealed" || (isPrivileged(audience) && (phase === "locked" || phase === "judging"));
