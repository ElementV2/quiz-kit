import type { z } from "zod";
import type { HintsMechanicView } from "@quiz/schema";
import { defineMechanic } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { isPrivileged, overrule } from "../shared/answers.ts";
import { correctOf, initCore, regradeCore, judgeCore, pointsAt, ProgressiveConfig, ProgressiveCore, removeFromCore, revealStep, submitCore } from "../shared/progressive.ts";

/**
 * Decreasing hints (doc 03 `hints`): the question's `hints[]` are shown one by one (`element.reveal { index }`,
 * the first one at presentation); a right answer is worth `maxPoints` with one hint, `minPoints` with all.
 * Each player's value is frozen when they answer. Overrule with `answer.judge` until the reveal.
 */

export const HintsConfig = ProgressiveConfig;
export const HintsState = ProgressiveCore.extend({ hints: ProgressiveCore.shape.accepted });
export type HintsState = z.infer<typeof HintsState>;

export const hints = defineMechanic<ProgressiveConfig, HintsState>({
  id: "hints",
  configSchema: HintsConfig,
  stateSchema: HintsState,

  init(cfg, question) {
    if (question.hints.length === 0) return err("invalid", "la question n'a aucun indice");
    const core = initCore(cfg, question, question.hints.length, "hints");
    return core.ok ? ok({ ...core.value, hints: [...question.hints] }) : core;
  },

  submit: (s, pid, answer, env) => submitCore(s, pid, answer, env.at),

  onAction(s, a, env) {
    if (a.type === "element.reveal") return revealStep(s, a.index, env.phase);
    if (a.type === "answer.judge") return overrule(s, a.participantId, a.correct, env.phase);
    return null;
  },

  judge: judgeCore,
  regrade: regradeCore,
  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: removeFromCore,
  answerOf: (s, pid) => s.answers.find((a) => a.participantId === pid)?.value ?? null,
  answers: (s) => s.answers.map((a) => ({ participantId: a.participantId, optionIds: a.value, at: a.at })),

  project(s, env): HintsMechanicView {
    const revealed = env.phase === "revealed";
    return {
      mechanic: "hints",
      // The hidden hints never leave the server (host / control see them all, to read ahead).
      hints: revealed || isPrivileged(env.audience) ? [...s.hints] : s.hints.slice(0, s.shown),
      hintCount: revealed ? s.total : s.shown,
      total: s.total,
      points: pointsAt(s, s.shown),
      input: s.input,
      options: s.input === "choice" ? s.options.map((o) => ({ ...o })) : null,
      correct: revealed || isPrivileged(env.audience) ? correctOf(s) : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
