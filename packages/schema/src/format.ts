import { z } from "zod";
import { FormatId, QuestionId, RoundId } from "./ids.ts";

export const ParticipantsConfig = z
  .strictObject({
    mode: z.enum(["solo", "teams", "crowd"]),
    min: z.number().int().min(0),
    max: z.number().int().min(1),
    teamSize: z.number().int().min(1).optional(),
  })
  .refine((p) => p.min <= p.max, "participants.min > participants.max");
export type ParticipantsConfig = z.infer<typeof ParticipantsConfig>;

/** Composable scoring components (doc 02). Phase 0 implements base, timeDecay and penalty. */
export const ScoringComponent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("base"), points: z.number().int() }),
  z.strictObject({
    type: z.literal("timeDecay"),
    /** Points lost linearly from `points` down to `minPoints` over the answer window. */
    minPoints: z.number().int(),
  }),
  z.strictObject({ type: z.literal("penalty"), points: z.number().int().max(0) }),
  z.strictObject({ type: z.literal("multiplier"), factor: z.number().positive() }),
]);
export type ScoringComponent = z.infer<typeof ScoringComponent>;

export const ScoringRule = z.array(ScoringComponent).min(1);
export type ScoringRule = z.infer<typeof ScoringRule>;

export const TimerConfig = z.strictObject({
  durationMs: z.number().int().min(1000).max(3_600_000),
  /** Lock answers automatically when the timer expires. */
  autoLock: z.boolean().default(true),
});
export type TimerConfig = z.infer<typeof TimerConfig>;

export const Round = z.strictObject({
  id: RoundId,
  title: z.string().min(1).max(200),
  /** Registered mechanic id (ADR-0002). */
  mechanic: z.string().min(1),
  /** Validated by the mechanic's own configSchema when the session is created (ADR-0007). */
  mechanicConfig: z.unknown().default({}),
  questions: z.array(QuestionId).min(1),
  reserve: z.array(QuestionId).default([]),
  timer: TimerConfig.optional(),
  scoring: ScoringRule,
});
export type Round = z.infer<typeof Round>;

export const Format = z.strictObject({
  id: FormatId,
  name: z.string().min(1).max(200),
  participants: ParticipantsConfig,
  rounds: z.array(Round).min(1),
  tieBreak: z.enum(["speed", "control"]).default("control"),
});
export type Format = z.infer<typeof Format>;
