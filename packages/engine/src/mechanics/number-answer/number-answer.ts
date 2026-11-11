import { unsupportedQuestion } from "@quiz/schema";
import { z } from "zod";
import type { NumberAnswerMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, showsResults, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";

/** A setting read from a state that an older snapshot may lack (raw JSON, no defaults applied). */
const flag = (v: boolean | undefined, byDefault: boolean): boolean => v ?? byDefault;

/**
 * Number (doc 03 `number-answer`): `tolerance` = right when |answer − correct| ≤ tolerance;
 * `closest` = the closest answer(s) win (ties all win, the tolerance still counts as exact).
 * Overrule with `answer.judge` until the reveal. Points: the round's ScoringRule.
 */

export const NumberAnswerConfig = z.strictObject({
  mode: z.enum(["tolerance", "closest"]).default("tolerance"),
  allowChange: z.boolean().default(true),
  /** Also right within this % of the right value (on top of the question's own tolerance). 0 = off. */
  tolerancePercent: z.number().min(0).max(100).default(0),
  /** « closest » mode: how many players win (the N closest, ties included). */
  winners: z.number().int().min(1).max(100).default(1),
  /** « tolerance » mode: points by precision — 100 % right on, 50 % at the tolerance edge. */
  graded: z.boolean().default(false),
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
  tolerancePercent: z.number().default(0),
  winners: z.number().int().default(1),
  graded: z.boolean().default(false),
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

/** The question's tolerance, widened by the % setting (older snapshots: no %). */
const toleranceOf = (s: S): number => Math.max(s.tolerance, (Math.abs(s.correct) * (s.tolerancePercent ?? 0)) / 100);

function computeWinners(s: S): ReadonlySet<string> {
  const gaps = s.answers.map((a) => ({ id: a.participantId, gap: Math.abs(valueOf(a) - s.correct) }));
  const tol = toleranceOf(s);
  if (s.mode === "tolerance") return new Set(gaps.filter((g) => g.gap <= tol).map((g) => g.id));
  if (gaps.length === 0) return new Set();
  // The N closest win (ties with the N-th included), and anyone within the tolerance.
  const sorted = gaps.map((g) => g.gap).toSorted((a, b) => a - b);
  const nth = sorted[Math.min(sorted.length, s.winners ?? 1) - 1] ?? 0;
  const best = Math.max(nth, tol);
  return new Set(gaps.filter((g) => g.gap <= best).map((g) => g.id));
}

/** Graded points (tolerance mode): 1 right on, 0.5 at the tolerance edge. */
function shareOf(s: S, a: StoredAnswer): number | undefined {
  if (!flag(s.graded, false) || s.mode !== "tolerance") return undefined;
  const tol = toleranceOf(s);
  if (tol <= 0) return undefined;
  return Math.max(0.5, 1 - (0.5 * Math.abs(valueOf(a) - s.correct)) / tol);
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

  reconfigure(s, cfg) {
    return { ...s, mode: cfg.mode, allowChange: cfg.allowChange, tolerancePercent: cfg.tolerancePercent, winners: cfg.winners, graded: cfg.graded };
  },

  init(cfg, question) {
    const a = question.answerSpec;
    if (a.kind !== "number") return err("unsupported", unsupportedQuestion("number-answer", a.kind));
    return ok({ mode: cfg.mode, correct: a.correct, tolerance: a.tolerance, unit: a.unit ?? null, min: a.min ?? null, max: a.max ?? null, allowChange: cfg.allowChange, tolerancePercent: cfg.tolerancePercent, winners: cfg.winners, graded: cfg.graded, answers: [], overrules: [] });
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
    return s.answers.map((a): Judgement => {
      const right = verdict(s.overrules, a.participantId, w.has(a.participantId));
      const overruled = s.overrules.some((o) => o.participantId === a.participantId);
      const share = right && !overruled ? shareOf(s, a) : undefined;
      return share === undefined || share >= 1 ? { kind: "rule", participantId: a.participantId, outcome: right ? "correct" : "wrong", answeredAt: a.at } : { kind: "rule", participantId: a.participantId, outcome: "correct", answeredAt: a.at, share };
    });
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
