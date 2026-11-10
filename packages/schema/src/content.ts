import { z } from "zod";
import { MediaHash, OptionId, QuestionId } from "./ids.ts";

export const Media = z.strictObject({
  hash: MediaHash,
  mime: z.string().min(3).max(100),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  inMs: z.number().int().nonnegative().optional(),
  outMs: z.number().int().nonnegative().optional(),
});
export type Media = z.infer<typeof Media>;

export const Option = z.strictObject({
  id: OptionId,
  label: z.string().min(1).max(500),
  media: Media.optional(),
  value: z.number().optional(),
  synonyms: z.array(z.string().min(1)).optional(),
});
export type Option = z.infer<typeof Option>;

const uniqueOptionIds = (options: readonly Option[]): boolean =>
  new Set(options.map((o) => o.id)).size === options.length;

const options = (min: number, max: number) =>
  z.array(Option).min(min).max(max).refine(uniqueOptionIds, "identifiants d'options en double");

export const SingleAnswer = z
  .strictObject({ kind: z.literal("single"), options: options(2, 6), correct: OptionId })
  .refine((a) => a.options.some((o) => o.id === a.correct), "la bonne réponse doit être une des options");

export const MultiAnswer = z
  .strictObject({
    kind: z.literal("multi"),
    options: options(2, 6),
    correct: z.array(OptionId).min(1),
    minPick: z.number().int().min(1).optional(),
    maxPick: z.number().int().min(1).optional(),
  })
  .refine((a) => a.correct.every((c) => a.options.some((o) => o.id === c)), "bonne réponse inconnue")
  .refine((a) => (a.minPick ?? 1) <= (a.maxPick ?? a.options.length), "minPick > maxPick");

export const BooleanAnswer = z.strictObject({ kind: z.literal("boolean"), correct: z.boolean() });

export const PollAnswer = z.strictObject({
  kind: z.literal("poll"),
  /** `value` = share of respondents (%), revealed slot by slot. */
  options: options(1, 12),
});

export const OralAnswer = z.strictObject({
  kind: z.literal("oral"),
  /** Shown to host / control only. */
  expected: z.string().min(1).max(500),
});

export const AnswerSpec = z.discriminatedUnion("kind", [SingleAnswer, MultiAnswer, BooleanAnswer, PollAnswer, OralAnswer]);
export type AnswerSpec = z.infer<typeof AnswerSpec>;
export type AnswerKind = AnswerSpec["kind"];

export const Question = z.strictObject({
  id: QuestionId,
  prompt: z.strictObject({ text: z.string().min(1).max(2000), media: Media.optional() }),
  answerSpec: AnswerSpec,
  hints: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  difficulty: z.number().int().min(1).max(5).optional(),
  /** Host notes: never projected to player / output views. */
  notes: z.string().max(5000).optional(),
});
export type Question = z.infer<typeof Question>;
