import { z } from "zod";
import { OptionId, type PairsMechanicView, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";

/**
 * Pairs (doc 03 `pairs`): match each left item with its right item. The right column is shuffled and gets
 * anonymous ids (`r0`, `r1`…) so that no id betrays its partner. Right = every pair matched.
 * Answer text form: ["leftId:rightId", …]. Overrule with `answer.judge`. Points: ScoringRule.
 */

export const PairsConfig = z.strictObject({ allowChange: z.boolean().default(true) });
export type PairsConfig = z.infer<typeof PairsConfig>;

export const PairsState = z.strictObject({
  left: z.array(z.strictObject({ id: OptionId, label: z.string() })),
  right: z.array(z.strictObject({ id: OptionId, label: z.string() })),
  correct: z.array(z.strictObject({ left: OptionId, right: OptionId })),
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
  overrules: z.array(Overrule),
});
export type PairsState = z.infer<typeof PairsState>;

const encode = (m: { left: string; right: string }) => `${m.left}:${m.right}`;

export const pairs = defineMechanic<PairsConfig, PairsState>({
  id: "pairs",
  configSchema: PairsConfig,
  stateSchema: PairsState,

  init(cfg, question, env) {
    const a = question.answerSpec;
    if (a.kind !== "pairs") return err("unsupported", unsupportedQuestion("pairs", a.kind));
    const shuffled = env.rng.shuffle(a.pairs).map((p, i) => ({ pair: p.id, id: `r${i}`, label: p.right }));
    return ok({
      left: a.pairs.map((p) => ({ id: p.id, label: p.left })),
      right: shuffled.map(({ id, label }) => ({ id, label })),
      correct: a.pairs.map((p) => ({ left: p.id, right: shuffled.find((r) => r.pair === p.id)?.id ?? "" })),
      allowChange: cfg.allowChange,
      answers: [],
      overrules: [],
    });
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "pairs") return err("invalid", "des associations sont attendues");
    const m = answer.matches;
    const lefts = new Set(m.map((x) => x.left));
    const rights = new Set(m.map((x) => x.right));
    if (m.length !== s.left.length || lefts.size !== m.length || rights.size !== m.length) return err("invalid", "associer chaque élément une seule fois");
    if (!m.every((x) => s.left.some((l) => l.id === x.left) && s.right.some((r) => r.id === x.right))) return err("invalid", "élément inconnu");
    const sorted = s.left.map((l) => m.find((x) => x.left === l.id)).filter((x) => x !== undefined);
    return storeAnswer(s, participantId, sorted.map(encode), env.at);
  },

  onAction(s, a, env) {
    if (a.type !== "answer.judge") return null;
    return overrule(s, a.participantId, a.correct, env.phase);
  },

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind !== "pairs") return err("invalid", "type de réponse différent");
    // The shown items stay; the new pairs are matched by label.
    const correct: { left: string; right: string }[] = [];
    for (const p of a.pairs) {
      const left = s.left.find((l) => l.label === p.left);
      const right = s.right.find((r) => r.label === p.right);
      if (left === undefined || right === undefined) return err("invalid", `élément inconnu : ${left === undefined ? p.left : p.right}`);
      correct.push({ left: left.id, right: right.id });
    }
    if (correct.length !== s.left.length) return err("invalid", "chaque élément de gauche doit avoir sa paire");
    return ok({ ...s, correct });
  },

  judge(s): Judgement[] {
    const right = new Set(s.correct.map(encode));
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: verdict(s.overrules, a.participantId, a.value.length === right.size && a.value.every((v) => right.has(v))) ? "correct" : "wrong", answeredAt: a.at }));
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid), overrules: s.overrules.filter((o) => o.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): PairsMechanicView {
    return {
      mechanic: "pairs",
      left: s.left.map((x) => ({ ...x })),
      right: s.right.map((x) => ({ ...x })),
      correct: isPrivileged(env.audience) || env.phase === "revealed" ? s.correct.map((x) => ({ ...x })) : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
