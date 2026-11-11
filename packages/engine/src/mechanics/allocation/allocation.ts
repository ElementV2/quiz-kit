import { z } from "zod";
import { Media, OptionId, type AllocationMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, showsResults, storeAnswer, StoredAnswer } from "../shared/answers.ts";

/**
 * Allocation (doc 03 `allocation`, "Money Drop"-like): each player spreads the whole budget over the options;
 * the amount left on the right option is won (fixed points, the round's ScoringRule is not used).
 * `keepOneEmpty` (default): at least one option must stay empty, as in the TV format.
 * Answer text form: ["optionId:amount", …] for every option.
 */

export const AllocationConfig = z.strictObject({
  allowChange: z.boolean().default(true),
  keepOneEmpty: z.boolean().default(true),
});
export type AllocationConfig = z.infer<typeof AllocationConfig>;

export const AllocationState = z.strictObject({
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: OptionId,
  budget: z.number().int(),
  keepOneEmpty: z.boolean(),
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
});
export type AllocationState = z.infer<typeof AllocationState>;

type S = AllocationState;

function amountsOf(a: StoredAnswer): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of a.value) {
    const i = v.lastIndexOf(":");
    m.set(v.slice(0, i), Number(v.slice(i + 1)));
  }
  return m;
}

const won = (s: S, a: StoredAnswer): number => amountsOf(a).get(s.correct) ?? 0;

const countsCache = new WeakMap<S, Record<string, number>>();
/** Sums per option, once per state (shared by every projection). */
function countsOf(s: S): Record<string, number> {
  let c = countsCache.get(s);
  if (c === undefined) {
    const sums: Record<string, number> = Object.fromEntries(s.options.map((o) => [o.id, 0]));
    for (const a of s.answers) for (const [id, n] of amountsOf(a)) sums[id] = (sums[id] ?? 0) + n;
    c = sums;
    countsCache.set(s, c);
  }
  return c;
}

export const allocation = defineMechanic<AllocationConfig, AllocationState>({
  id: "allocation",
  configSchema: AllocationConfig,
  stateSchema: AllocationState,
  ownPoints: true,

  init(cfg, question) {
    const a = question.answerSpec;
    if (a.kind !== "allocation") return err("unsupported", `la mécanique allocation ne gère pas les questions ${a.kind}`);
    return ok({
      options: a.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })),
      correct: a.correct,
      budget: a.budget,
      keepOneEmpty: cfg.keepOneEmpty,
      allowChange: cfg.allowChange,
      answers: [],
    });
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "allocation") return err("invalid", "une répartition est attendue");
    const ids = answer.amounts.map((x) => x.optionId);
    if (new Set(ids).size !== ids.length || !ids.every((id) => s.options.some((o) => o.id === id))) return err("invalid", "option inconnue ou en double");
    const total = answer.amounts.reduce((sum, x) => sum + x.amount, 0);
    if (total !== s.budget) return err("invalid", `répartir exactement ${s.budget} (reçu ${total})`);
    const by = new Map(answer.amounts.map((x) => [x.optionId, x.amount]));
    if (s.keepOneEmpty && s.options.every((o) => (by.get(o.id) ?? 0) > 0)) return err("invalid", "laisser au moins une proposition vide");
    return storeAnswer(s, participantId, s.options.map((o) => `${o.id}:${by.get(o.id) ?? 0}`), env.at);
  },

  onAction: () => null,

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind !== "allocation" || !s.options.some((o) => o.id === a.correct)) return err("invalid", "la bonne réponse doit être une des propositions");
    return ok({ ...s, correct: a.correct });
  },

  judge(s): Judgement[] {
    return s.answers.map((a) => {
      const points = won(s, a);
      return { kind: "fixed", target: { participantId: a.participantId }, outcome: points > 0 ? "correct" : "wrong", points };
    });
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): AllocationMechanicView {
    const counts = showsResults(env.audience, env.phase) ? countsOf(s) : null;
    return {
      mechanic: "allocation",
      options: s.options.map((o) => ({ ...o })),
      budget: s.budget,
      keepOneEmpty: s.keepOneEmpty,
      correct: isPrivileged(env.audience) || env.phase === "revealed" ? s.correct : null,
      counts,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
