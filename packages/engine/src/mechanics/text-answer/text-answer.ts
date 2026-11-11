import { z } from "zod";
import type { TextAnswerMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";
import { matchesText } from "../shared/text-match.ts";

/**
 * Free text (doc 03 `text-answer`): every player types an answer, judged automatically with fuzzy matching
 * (accents, case, punctuation, leading article, typos by length). Control / host may overrule a verdict
 * (`answer.judge { participantId, correct }`) until the reveal. Points: the round's ScoringRule.
 */

export const TextAnswerConfig = z.strictObject({ allowChange: z.boolean().default(true) });
export type TextAnswerConfig = z.infer<typeof TextAnswerConfig>;

export const TextAnswerState = z.strictObject({
  accepted: z.array(z.string()).min(1),
  maxDistance: z.number().int().nullable(),
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
  overrules: z.array(Overrule),
});
export type TextAnswerState = z.infer<typeof TextAnswerState>;

const spec = (s: TextAnswerState) => ({ accepted: s.accepted, maxDistance: s.maxDistance ?? undefined });
const autoOk = (s: TextAnswerState, a: StoredAnswer): boolean => matchesText(a.value[0] ?? "", spec(s));

export const textAnswer = defineMechanic<TextAnswerConfig, TextAnswerState>({
  id: "text-answer",
  configSchema: TextAnswerConfig,
  stateSchema: TextAnswerState,

  init(cfg, question) {
    const a = question.answerSpec;
    if (a.kind === "text") return ok({ accepted: [...a.accepted], maxDistance: a.maxDistance ?? null, allowChange: cfg.allowChange, answers: [], overrules: [] });
    // A single-choice question can be played as free text: the right option's label (and synonyms) is the answer.
    if (a.kind === "single") {
      const right = a.options.find((o) => o.id === a.correct);
      if (right !== undefined) return ok({ accepted: [right.label, ...(right.synonyms ?? [])], maxDistance: null, allowChange: cfg.allowChange, answers: [], overrules: [] });
    }
    return err("unsupported", `la mécanique text-answer ne gère pas les questions ${a.kind}`);
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "text") return err("invalid", "réponse texte attendue");
    return storeAnswer(s, participantId, [answer.text], env.at);
  },

  onAction(s, a, env) {
    if (a.type !== "answer.judge") return null;
    return overrule(s, a.participantId, a.correct, env.phase);
  },

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind === "text") return ok({ ...s, accepted: [...a.accepted], maxDistance: a.maxDistance ?? null });
    if (a.kind === "single") {
      const right = a.options.find((o) => o.id === a.correct);
      if (right !== undefined) return ok({ ...s, accepted: [right.label, ...(right.synonyms ?? [])] });
    }
    return err("invalid", "type de réponse différent");
  },

  judge(s): Judgement[] {
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: verdict(s.overrules, a.participantId, autoOk(s, a)) ? "correct" : "wrong", answeredAt: a.at }));
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid), overrules: s.overrules.filter((o) => o.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): TextAnswerMechanicView {
    const privileged = isPrivileged(env.audience);
    return {
      mechanic: "text-answer",
      correct: privileged || env.phase === "revealed" ? (s.accepted[0] ?? null) : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
      review: privileged
        ? s.answers.map((a) => {
            const auto = autoOk(s, a);
            const o = s.overrules.find((x) => x.participantId === a.participantId);
            return { participantId: a.participantId, text: a.value[0] ?? "", accepted: o?.correct ?? auto, overruled: o !== undefined && o.correct !== auto };
          })
        : null,
    };
  },
});
