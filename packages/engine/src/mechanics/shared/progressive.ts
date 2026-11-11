import { z } from "zod";
import { Media, OptionId, ParticipantId, type AnswerValue, type Phase, type Question } from "@quiz/schema";
import type { Judgement } from "../../mechanic.ts";
import { err, ok, type Rejection, type Result } from "../../result.ts";
import { Overrule, verdict } from "./answers.ts";
import { matchesText } from "./text-match.ts";

/**
 * Shared by `hints` and `reveal-image`: something is uncovered step by step (`element.reveal { index }` with
 * index = the next step), and a right answer is worth more the earlier it comes. The answer is typed (`text`
 * question, fuzzy) or picked (`single` question). Points are fixed (decided here, not by the ScoringRule):
 * linear from `maxPoints` (answered at the first step) down to `minPoints` (everything shown).
 */

export const ProgressiveConfig = z
  .strictObject({
    maxPoints: z.number().int().min(0).max(1_000_000).default(100),
    minPoints: z.number().int().min(0).max(1_000_000).default(10),
    /** A player may answer again (at the current, lower, value). */
    allowChange: z.boolean().default(false),
  })
  .refine((c) => c.minPoints <= c.maxPoints, "minPoints > maxPoints");
export type ProgressiveConfig = z.infer<typeof ProgressiveConfig>;

const OptionLite = z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() });

export const ProgressiveCore = z.strictObject({
  input: z.enum(["text", "choice"]),
  /** text: accepted answers (first = canonical); choice: unused. */
  accepted: z.array(z.string()),
  maxDistance: z.number().int().nullable(),
  options: z.array(OptionLite),
  /** choice: right option id. */
  correctOption: OptionId.nullable(),
  /** Steps uncovered so far (≥ 1: the first one is shown at presentation). */
  shown: z.number().int().min(0),
  total: z.number().int().min(1),
  maxPoints: z.number().int(),
  minPoints: z.number().int(),
  allowChange: z.boolean(),
  answers: z.array(z.strictObject({ participantId: ParticipantId, value: z.array(z.string().max(200)), at: z.number().int(), shown: z.number().int() })),
  overrules: z.array(Overrule),
});
export type ProgressiveCore = z.infer<typeof ProgressiveCore>;

export function initCore(cfg: ProgressiveConfig, question: Question, total: number, mechanicId: string): Result<ProgressiveCore, Rejection> {
  const a = question.answerSpec;
  const common = { shown: Math.min(1, total), total, maxPoints: cfg.maxPoints, minPoints: cfg.minPoints, allowChange: cfg.allowChange, answers: [], overrules: [] };
  if (a.kind === "text") return ok({ input: "text", accepted: [...a.accepted], maxDistance: a.maxDistance ?? null, options: [], correctOption: null, ...common });
  if (a.kind === "single") {
    return ok({ input: "choice", accepted: [], maxDistance: null, options: a.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })), correctOption: a.correct, ...common });
  }
  return err("unsupported", `la mécanique ${mechanicId} ne gère que les questions text ou single (reçu ${a.kind})`);
}

/** Points for a right answer given when `shown` steps are visible. */
export function pointsAt(c: ProgressiveCore, shown: number): number {
  if (c.total <= 1) return c.maxPoints;
  const t = Math.min(Math.max(shown - 1, 0), c.total - 1) / (c.total - 1);
  return Math.round(c.maxPoints - (c.maxPoints - c.minPoints) * t);
}

const autoOk = (c: ProgressiveCore, value: readonly string[]): boolean =>
  c.input === "text" ? matchesText(value[0] ?? "", { accepted: c.accepted, maxDistance: c.maxDistance ?? undefined }) : value[0] === c.correctOption;

export function submitCore<S extends ProgressiveCore>(s: S, participantId: string, answer: AnswerValue, at: number): Result<S, Rejection> {
  let value: string[];
  if (s.input === "text") {
    if (answer.kind !== "text") return err("invalid", "réponse texte attendue");
    value = [answer.text];
  } else {
    if (answer.kind !== "choice" || answer.optionIds.length !== 1) return err("invalid", "choisir une proposition");
    const id = answer.optionIds[0] ?? "";
    if (!s.options.some((o) => o.id === id)) return err("invalid", "option inconnue");
    value = [id];
  }
  const existing = s.answers.some((x) => x.participantId === participantId);
  if (existing && !s.allowChange) return err("conflict", "réponse déjà enregistrée");
  return ok({ ...s, answers: [...s.answers.filter((x) => x.participantId !== participantId), { participantId, value, at, shown: s.shown }] });
}

const REVEALABLE: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging"]);

/** `element.reveal { index }`: index must be the next step (a repeated click is refused, never double-applied). */
export function revealStep<S extends ProgressiveCore>(s: S, index: number, phase: Phase): Result<S, Rejection> {
  if (!REVEALABLE.has(phase)) return err("wrong-phase", "aucune question en cours");
  if (s.shown >= s.total) return err("conflict", "tout est déjà dévoilé");
  if (index < s.shown) return err("conflict", "déjà dévoilé");
  if (index !== s.shown) return err("invalid", `dévoiler dans l'ordre : prochain = ${s.shown}`);
  return ok({ ...s, shown: s.shown + 1 });
}

/** New right answer for hints / reveal-image (same input type). */
export function regradeCore<S extends ProgressiveCore>(s: S, question: Question): Result<S, Rejection> {
  const a = question.answerSpec;
  if (s.input === "text" && a.kind === "text") return ok({ ...s, accepted: [...a.accepted], maxDistance: a.maxDistance ?? null });
  if (s.input === "choice" && a.kind === "single" && s.options.some((o) => o.id === a.correct)) return ok({ ...s, correctOption: a.correct });
  return err("invalid", "type de réponse différent");
}

export function judgeCore(c: ProgressiveCore): Judgement[] {
  return c.answers.map((a) => {
    const right = verdict(c.overrules, a.participantId, autoOk(c, a.value));
    return { kind: "fixed", target: { participantId: a.participantId }, outcome: right ? "correct" : "wrong", points: right ? pointsAt(c, a.shown) : 0 };
  });
}

export const correctOf = (c: ProgressiveCore): string | null => (c.input === "text" ? (c.accepted[0] ?? null) : c.correctOption);

export const removeFromCore = <S extends ProgressiveCore>(s: S, pid: string): S => ({
  ...s,
  answers: s.answers.filter((a) => a.participantId !== pid),
  overrules: s.overrules.filter((o) => o.participantId !== pid),
});
