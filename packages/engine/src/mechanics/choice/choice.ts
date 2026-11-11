import { z } from "zod";
import { Media, OptionId, ParticipantId, type ChoiceMechanicView, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { assertNever, err, ok } from "../../result.ts";

export const ChoiceConfig = z.strictObject({
  /** Shuffle option order at presentation (seeded RNG, identical for every viewer). */
  shuffleOptions: z.boolean().default(false),
  /** A player may change their answer until lock. */
  allowChange: z.boolean().default(true),
});
export type ChoiceConfig = z.infer<typeof ChoiceConfig>;

export const ChoiceState = z.strictObject({
  kind: z.enum(["single", "multi", "boolean"]),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: z.array(OptionId),
  minPick: z.number().int(),
  maxPick: z.number().int(),
  allowChange: z.boolean(),
  answers: z.array(z.strictObject({ participantId: ParticipantId, optionIds: z.array(OptionId), at: z.number().int() })),
});
export type ChoiceState = z.infer<typeof ChoiceState>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export const choice = defineMechanic<ChoiceConfig, ChoiceState>({
  id: "choice",
  configSchema: ChoiceConfig,
  stateSchema: ChoiceState,

  init(cfg, question, env) {
    const spec = question.answerSpec;
    let base: Omit<ChoiceState, "allowChange" | "answers">;
    switch (spec.kind) {
      case "single":
        base = { kind: "single", options: spec.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })), correct: [spec.correct], minPick: 1, maxPick: 1 };
        break;
      case "multi":
        base = {
          kind: "multi",
          options: spec.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })),
          correct: [...spec.correct],
          minPick: spec.minPick ?? 1,
          maxPick: spec.maxPick ?? spec.options.length,
        };
        break;
      case "boolean":
        base = { kind: "boolean", options: [{ id: "true", label: "Vrai" }, { id: "false", label: "Faux" }], correct: [String(spec.correct)], minPick: 1, maxPick: 1 };
        break;
      case "poll":
      case "oral":
      case "text":
      case "number":
      case "order":
      case "pairs":
      case "pin":
      case "allocation":
        return err("unsupported", unsupportedQuestion("choice", spec.kind));
      default:
        return assertNever(spec);
    }
    const options = cfg.shuffleOptions && base.kind !== "boolean" ? env.rng.shuffle(base.options) : base.options;
    return ok({ ...base, options, allowChange: cfg.allowChange, answers: [] });
  },

  submit(s, participantId, answer, env) {
    switch (answer.kind) {
      case "choice": {
        const ids = answer.optionIds;
        if (new Set(ids).size !== ids.length) return err("invalid", "option en double");
        if (!ids.every((id) => s.options.some((o) => o.id === id))) return err("invalid", "option inconnue");
        if (ids.length < s.minPick || ids.length > s.maxPick) return err("invalid", `choisir entre ${s.minPick} et ${s.maxPick} option(s)`);
        const existing = s.answers.find((a) => a.participantId === participantId);
        if (existing !== undefined && !s.allowChange) return err("conflict", "réponse déjà enregistrée");
        const rest = s.answers.filter((a) => a.participantId !== participantId);
        return ok({ ...s, answers: [...rest, { participantId, optionIds: [...ids], at: env.at }] });
      }
      case "text":
      case "number":
      case "order":
      case "pairs":
      case "pin":
      case "allocation":
        return err("invalid", "réponse à choix attendue");
      default:
        return assertNever(answer);
    }
  },

  onAction() {
    return null;
  },

  regrade(s, question) {
    const a = question.answerSpec;
    const shown = (ids: readonly string[]) => ids.every((id) => s.options.some((o) => o.id === id));
    if (a.kind === "single") return shown([a.correct]) ? ok({ ...s, correct: [a.correct] }) : err("invalid", "la bonne réponse doit être une des propositions affichées");
    if (a.kind === "multi") return shown(a.correct) && a.correct.length <= s.maxPick ? ok({ ...s, correct: [...a.correct] }) : err("invalid", "les bonnes réponses doivent être des propositions affichées");
    if (a.kind === "boolean") return ok({ ...s, correct: [String(a.correct)] });
    return err("invalid", "type de réponse différent");
  },

  endsRound() {
    return false;
  },

  closeRound() {
    return [];
  },

  judge(s): Judgement[] {
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: sameSet(a.optionIds, s.correct) ? "correct" : "wrong", answeredAt: a.at }));
  },

  removeParticipant(s, participantId) {
    return { ...s, answers: s.answers.filter((a) => a.participantId !== participantId) };
  },

  answerOf(s, participantId) {
    return s.answers.find((a) => a.participantId === participantId)?.optionIds ?? null;
  },

  answers(s) {
    return s.answers;
  },

  project(s, env): ChoiceMechanicView {
    const revealed = env.phase === "revealed";
    const privileged = env.audience === "host" || env.audience === "control";
    const showCounts = revealed || (privileged && (env.phase === "locked" || env.phase === "judging"));
    const counts: Record<string, number> = {};
    if (showCounts) {
      for (const o of s.options) counts[o.id] = 0;
      for (const a of s.answers) for (const id of a.optionIds) counts[id] = (counts[id] ?? 0) + 1;
    }
    return {
      mechanic: "choice",
      kind: s.kind,
      options: s.options.map((o) => ({ ...o })),
      minPick: s.minPick,
      maxPick: s.maxPick,
      correct: revealed || privileged ? [...s.correct] : null,
      counts: showCounts ? counts : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
