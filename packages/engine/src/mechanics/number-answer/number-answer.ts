import { z } from "zod";
import type { NumberAnswerMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, showsResults, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";

/**
 * Number (doc 03 `number-answer`): `tolerance` = right when |answer − correct| ≤ tolerance;
 * `closest` = the closest answer(s) win (ties all win, the tolerance still counts as exact).
 * Overrule with `answer.judge` until the reveal. Points: the round's ScoringRule.
 */

export const NumberAnswerConfig = z.strictObject({
  mode: z.enum(["tolerance", "closest"]).default("tolerance"),
  allowChange: z.boolean().default(true),
});
export type NumberAnswerConfig = z.infer<typeof NumberAnswerConfig>;

export const NumberAnswerState = z.strictObject({
  mode: z.enum(["tolerance", "closest"]),
  correct: z.number(),
  tolerance: z.number(),
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
  overrules: z.array(Overrule),
});
export type NumberAnswerState = z.infer<typeof NumberAnswerState>;

type S = NumberAnswerState;

const valueOf = (a: StoredAnswer): number => Number(a.value[0]);

const winnersCache = new WeakMap<S, ReadonlySet<string>>();

/** Memoised per state: judge() and 500 projections share one computation. */
function winners(s: S): ReadonlySet<string> {
  let w = winnersCache.get(s);
  if (w === undefined) {
    w = computeWinners(s);
    winnersCache.set(s, w);
  }
  return w;
}

function computeWinners(s: S): ReadonlySet<string> {
  const gaps = s.answers.map((a) => ({ id: a.participantId, gap: Math.abs(valueOf(a) - s.correct) }));
  if (s.mode === "tolerance") return new Set(gaps.filter((g) => g.gap <= s.tolerance).map((g) => g.id));
  if (gaps.length === 0) return new Set();
  const best = Math.max(Math.min(...gaps.map((g) => g.gap)), s.tolerance);
  return new Set(gaps.filter((g) => g.gap <= best).map((g) => g.id));
}

const rankingCache = new WeakMap<S, NumberAnswerMechanicView["ranking"]>();
function rankingOf(s: S): NumberAnswerMechanicView["ranking"] {
  let r = rankingCache.get(s);
  if (r === undefined) {
    const w = winners(s);
    r = s.answers
      .map((a) => ({ participantId: a.participantId, value: valueOf(a), gap: Math.abs(valueOf(a) - s.correct), win: verdict(s.overrules, a.participantId, w.has(a.participantId)) }))
      .toSorted((x, y) => x.gap - y.gap)
      .slice(0, 10);
    rankingCache.set(s, r);
  }
  return r;
}

export const numberAnswer = defineMechanic<NumberAnswerConfig, NumberAnswerState>({
  id: "number-answer",
  configSchema: NumberAnswerConfig,
  stateSchema: NumberAnswerState,

  init(cfg, question) {
    const a = question.answerSpec;
    if (a.kind !== "number") return err("unsupported", `la mécanique number-answer ne gère pas les questions ${a.kind}`);
    return ok({ mode: cfg.mode, correct: a.correct, tolerance: a.tolerance, unit: a.unit ?? null, min: a.min ?? null, max: a.max ?? null, allowChange: cfg.allowChange, answers: [], overrules: [] });
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "number") return err("invalid", "réponse numérique attendue");
    if ((s.min !== null && answer.value < s.min) || (s.max !== null && answer.value > s.max)) return err("invalid", `nombre attendu entre ${s.min ?? "−∞"} et ${s.max ?? "+∞"}`);
    return storeAnswer(s, participantId, [String(answer.value)], env.at);
  },

  onAction(s, a, env) {
    if (a.type !== "answer.judge") return null;
    return overrule(s, a.participantId, a.correct, env.phase);
  },

  regrade(s, question) {
    const a = question.answerSpec;
    if (a.kind !== "number") return err("invalid", "type de réponse différent");
    return ok({ ...s, correct: a.correct, tolerance: a.tolerance });
  },

  judge(s): Judgement[] {
    const w = winners(s);
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: verdict(s.overrules, a.participantId, w.has(a.participantId)) ? "correct" : "wrong", answeredAt: a.at }));
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid), overrules: s.overrules.filter((o) => o.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): NumberAnswerMechanicView {
    const secrets = isPrivileged(env.audience) || env.phase === "revealed";
    const shown = env.audience !== "player" && showsResults(env.audience, env.phase);
    return {
      mechanic: "number-answer",
      mode: s.mode,
      unit: s.unit,
      min: s.min,
      max: s.max,
      correct: secrets ? s.correct : null,
      tolerance: secrets ? s.tolerance : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
      // Not on tablets (their own result is `myResult`): one sort per state, not per player.
      ranking: shown ? rankingOf(s) : null,
    };
  },
});
