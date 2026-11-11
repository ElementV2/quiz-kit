import { z } from "zod";
import { Media, OptionId, ParticipantId, type ChoiceMechanicView, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { assertNever, err, ok } from "../../result.ts";

/** A setting read from a state that an older snapshot may lack (raw JSON, no defaults applied). */
const flag = (v: boolean | undefined, byDefault: boolean): boolean => v ?? byDefault;

export const ChoiceConfig = z.strictObject({
  /** Shuffle option order at presentation (seeded RNG, identical for every viewer). */
  shuffleOptions: z.boolean().default(false),
  /** A player may change their answer until lock. */
  allowChange: z.boolean().default(true),
  /** Several right answers: partial points (right ticks − wrong ticks) / right answers, instead of all or nothing. */
  partialMulti: z.boolean().default(false),
  /** Race: only the N fastest right answers score (0 = everyone who is right). */
  race: z.number().int().min(0).max(1000).default(0),
  /** Vote (no right answer): no points, or points to those who voted like the majority / the minority. */
  vote: z.enum(["none", "majority", "minority"]).default("none"),
});
export type ChoiceConfig = z.infer<typeof ChoiceConfig>;

export const ChoiceState = z.strictObject({
  kind: z.enum(["single", "multi", "boolean", "vote"]),
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: z.array(OptionId),
  minPick: z.number().int(),
  maxPick: z.number().int(),
  allowChange: z.boolean(),
  partialMulti: z.boolean().default(false),
  race: z.number().int().default(0),
  vote: z.enum(["none", "majority", "minority"]).default("none"),
  answers: z.array(z.strictObject({ participantId: ParticipantId, optionIds: z.array(OptionId), at: z.number().int() })),
});
export type ChoiceState = z.infer<typeof ChoiceState>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Votes per option (vote kind). */
function voteCounts(s: ChoiceState): Map<string, number> {
  const out = new Map<string, number>(s.options.map((o) => [o.id, 0]));
  for (const a of s.answers) for (const id of a.optionIds) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}
/** The most voted option(s) (ties included); none without a vote. */
function topVoted(s: ChoiceState): string[] {
  const c = voteCounts(s);
  const max = Math.max(0, ...c.values());
  return max === 0 ? [] : [...c].filter(([, n]) => n === max).map(([id]) => id);
}
/** The least voted option(s) among those voted for (ties included). */
function leastVoted(s: ChoiceState): string[] {
  const voted = [...voteCounts(s)].filter(([, n]) => n > 0);
  const min = Math.min(...voted.map(([, n]) => n));
  return voted.filter(([, n]) => n === min).map(([id]) => id);
}
/** The options that score for the vote's mode: the most voted (majority) or the least voted (minority). */
function voteWinners(s: ChoiceState): string[] {
  if ((s.vote ?? "none") !== "minority") return topVoted(s);
  const least = leastVoted(s);
  const top = new Set(topVoted(s));
  return least.every((id) => top.has(id)) ? [] : least; // all tied / one option voted: no minority
}

/** Vote: no points, or right for those who voted like the majority / the minority. */
function judgeVote(s: ChoiceState): Judgement[] {
  const mode = s.vote ?? "none";
  if (mode === "none") return [];
  const win = new Set(voteWinners(s));
  return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: a.optionIds.some((id) => win.has(id)) ? "correct" : "wrong", answeredAt: a.at }));
}
/** Race: only the `n` fastest right answers keep their points (the others are right, for 0 point). */
function raced(js: readonly Judgement[], n: number): Judgement[] {
  if (n <= 0) return [...js];
  const fastest = new Set(
    js.flatMap((j) => (j.kind === "rule" && j.outcome === "correct" ? [j] : [])).toSorted((a, b) => a.answeredAt - b.answeredAt).slice(0, n).map((j) => j.participantId),
  );
  return js.map((j) => (j.kind === "rule" && j.outcome === "correct" && !fastest.has(j.participantId) ? { ...j, share: 0 } : j));
}

export const choice = defineMechanic<ChoiceConfig, ChoiceState>({
  id: "choice",
  configSchema: ChoiceConfig,
  stateSchema: ChoiceState,

  reconfigure(s, cfg) {
    // Not the option order (already shown); everything that only decides how the answers will be scored.
    return { ...s, allowChange: cfg.allowChange, partialMulti: cfg.partialMulti, race: cfg.race, vote: cfg.vote };
  },

  init(cfg, question, env) {
    const spec = question.answerSpec;
    let base: Omit<ChoiceState, "allowChange" | "answers" | "partialMulti" | "race" | "vote">;
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
      case "vote":
        base = { kind: "vote", options: spec.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })), correct: [], minPick: 1, maxPick: 1 };
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
    return ok({ ...base, options, allowChange: cfg.allowChange, partialMulti: cfg.partialMulti, race: cfg.race, vote: cfg.vote, answers: [] });
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
    if (s.kind === "vote") return judgeVote(s);
    const all = s.answers.map((a): Judgement => {
      if (s.kind !== "multi" || !flag(s.partialMulti, false) || sameSet(a.optionIds, s.correct)) return { kind: "rule", participantId: a.participantId, outcome: sameSet(a.optionIds, s.correct) ? "correct" : "wrong", answeredAt: a.at };
      const good = a.optionIds.filter((x) => s.correct.includes(x)).length;
      const share = Math.max(0, (good - (a.optionIds.length - good)) / s.correct.length);
      return share > 0 ? { kind: "rule", participantId: a.participantId, outcome: "correct", answeredAt: a.at, share } : { kind: "rule", participantId: a.participantId, outcome: "wrong", answeredAt: a.at };
    });
    return raced(all, s.race ?? 0);
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
      // Vote: the most voted option(s) stand as « the answer » once revealed (no secret before: there is none).
      // Vote: the most voted choice(s) stand out (« En tête »), whatever scores (majority or minority).
      correct: s.kind === "vote" ? (revealed || privileged ? topVoted(s) : null) : revealed || privileged ? [...s.correct] : null,
      counts: showCounts ? counts : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
