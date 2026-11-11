import { z } from "zod";
import { Media, OptionId, type OrderMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";

/**
 * Order (doc 03 `order`): put the options in the right order (dates, sizes, rankings). The options are shown
 * shuffled with the session seed. Right = exact order. Overrule with `answer.judge`. Points: ScoringRule.
 */

export const OrderConfig = z.strictObject({ allowChange: z.boolean().default(true) });
export type OrderConfig = z.infer<typeof OrderConfig>;

export const OrderState = z.strictObject({
  shown: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: z.array(OptionId),
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
  overrules: z.array(Overrule),
});
export type OrderState = z.infer<typeof OrderState>;

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const order = defineMechanic<OrderConfig, OrderState>({
  id: "order",
  configSchema: OrderConfig,
  stateSchema: OrderState,

  init(cfg, question, env) {
    const a = question.answerSpec;
    if (a.kind !== "order") return err("unsupported", `la mécanique order ne gère pas les questions ${a.kind}`);
    const options = a.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label }));
    const correct = options.map((o) => o.id);
    let shown = env.rng.shuffle(options);
    // Never show the answer itself: rotate when the shuffle kept the right order.
    if (sameOrder(shown.map((o) => o.id), correct)) shown = [...shown.slice(1), ...shown.slice(0, 1)];
    return ok({ shown, correct, allowChange: cfg.allowChange, answers: [], overrules: [] });
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "order") return err("invalid", "un classement est attendu");
    const ids = answer.optionIds;
    if (ids.length !== s.correct.length || new Set(ids).size !== ids.length || !ids.every((id) => s.correct.includes(id))) {
      return err("invalid", "classer toutes les propositions, une seule fois chacune");
    }
    return storeAnswer(s, participantId, ids, env.at);
  },

  onAction(s, a, env) {
    if (a.type !== "answer.judge") return null;
    return overrule(s, a.participantId, a.correct, env.phase);
  },

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind !== "order") return err("invalid", "type de réponse différent");
    const ids = a.options.map((o) => o.id);
    if (ids.length !== s.correct.length || !ids.every((id) => s.correct.includes(id))) return err("invalid", "mêmes propositions attendues, dans le bon ordre");
    return ok({ ...s, correct: ids });
  },

  judge(s): Judgement[] {
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: verdict(s.overrules, a.participantId, sameOrder(a.value, s.correct)) ? "correct" : "wrong", answeredAt: a.at }));
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid), overrules: s.overrules.filter((o) => o.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): OrderMechanicView {
    return {
      mechanic: "order",
      options: s.shown.map((o) => ({ ...o })),
      correct: isPrivileged(env.audience) || env.phase === "revealed" ? [...s.correct] : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
