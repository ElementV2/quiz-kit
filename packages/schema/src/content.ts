import { z } from "zod";
import { ScoringRule } from "./format.ts";
import { MediaHash, OptionId, QuestionId } from "./ids.ts";

export const Media = z.strictObject({
  hash: MediaHash,
  mime: z.string().min(3).max(100),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
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

/** Vote (opinion poll, Kahoot-like): no right answer; the tablets vote, the screen shows the shares. */
export const VoteAnswer = z.strictObject({ kind: z.literal("vote"), options: options(2, 8) });

export const OralAnswer = z.strictObject({
  kind: z.literal("oral"),
  /** Shown to host / control only. */
  expected: z.string().min(1).max(500),
});

/** Free text (text-answer, hints, reveal-image): accent / case / punctuation-insensitive, small typos tolerated. */
export const TextAnswer = z.strictObject({
  kind: z.literal("text"),
  /** First = canonical answer (shown at reveal); the others are accepted synonyms. */
  accepted: z.array(z.string().trim().min(1).max(200).regex(/[0-9\p{L}]/u, "une réponse acceptée doit contenir une lettre ou un chiffre")).min(1).max(20),
  /** Typos tolerated (Levenshtein). Absent: 0 up to 4 letters, 1 up to 8, else 2. */
  maxDistance: z.number().int().min(0).max(3).optional(),
});

/** Number (number-answer): right within `tolerance`, or closest players win (mechanic config). */
export const NumberAnswer = z
  .strictObject({
    kind: z.literal("number"),
    correct: z.number(),
    tolerance: z.number().min(0).default(0),
    unit: z.string().max(20).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((a) => (a.min ?? -Infinity) <= a.correct && a.correct <= (a.max ?? Infinity), "la bonne réponse doit être entre min et max");

/** Order (order): options listed in the right order; shown shuffled. */
export const OrderAnswer = z.strictObject({ kind: z.literal("order"), options: options(3, 8) }); // 2 items: "the reverse of what is shown" would always win

/** Pairs (pairs): each left item goes with its right item; the right column is shown shuffled. */
export const PairsAnswer = z
  .strictObject({
    kind: z.literal("pairs"),
    pairs: z.array(z.strictObject({ id: OptionId, left: z.string().min(1).max(200), right: z.string().min(1).max(200) })).min(2).max(8),
  })
  .refine((a) => new Set(a.pairs.map((p) => p.id)).size === a.pairs.length, "identifiants de paires en double")
  // Two identical labels on one side cannot be told apart by a player.
  .refine((a) => new Set(a.pairs.map((p) => p.left)).size === a.pairs.length && new Set(a.pairs.map((p) => p.right)).size === a.pairs.length, "libellés en double dans une colonne");

/** Normalised rectangle (0..1) on the question image. */
export const NormRect = z
  .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .refine((r) => r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001, "zone hors de l'image");
export type NormRect = z.infer<typeof NormRect>;

/** Pin (pin): click on the question image (`prompt.media`), right inside `target`. */
export const PinAnswer = z.strictObject({ kind: z.literal("pin"), target: NormRect });

/** Allocation (allocation, "Money Drop"): spread a budget over options; what sits on the right one is won. */
export const AllocationAnswer = z
  .strictObject({ kind: z.literal("allocation"), options: options(2, 6), correct: OptionId, budget: z.number().int().min(1).max(10_000_000) })
  .refine((a) => a.options.some((o) => o.id === a.correct), "la bonne réponse doit être une des options");

export const AnswerSpec = z.discriminatedUnion("kind", [SingleAnswer, MultiAnswer, BooleanAnswer, VoteAnswer, PollAnswer, OralAnswer, TextAnswer, NumberAnswer, OrderAnswer, PairsAnswer, PinAnswer, AllocationAnswer]);
export type AnswerSpec = z.infer<typeof AnswerSpec>;
export type AnswerKind = AnswerSpec["kind"];

/** `difficulty` (never used) may still be in older documents: dropped on read. */
export const Question = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) && "difficulty" in v ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "difficulty")) : v),
  z.strictObject({
    id: QuestionId,
    prompt: z.strictObject({ text: z.string().min(1).max(2000), media: Media.optional() }),
    answerSpec: AnswerSpec,
    hints: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
    /** Host notes: never projected to player / output views. */
    notes: z.string().max(5000).optional(),
    /**
     * This question's own points rule (fixed points, decay…): wins over its category's rule (mixed round) and the
     * round's barème. Absent: the category's / round's. Mechanics that decide their own points ignore it.
     */
    scoring: ScoringRule.optional(),
  }),
);
export type Question = z.infer<typeof Question>;
