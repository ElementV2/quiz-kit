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

export const ScoringRule = z
  .array(ScoringComponent)
  .min(1)
  .refine((r) => r.filter((c) => c.type === "timeDecay").length <= 1, "un seul timeDecay par règle")
  .refine((r) => {
    const base = r.reduce((sum, c) => (c.type === "base" ? sum + c.points : sum), 0);
    return r.every((c) => c.type !== "timeDecay" || c.minPoints <= base);
  }, "timeDecay.minPoints doit être ≤ aux points de base");
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

/**
 * Show flow (doc 07 « machine d'états en nodes »): what follows a round. Without a transition from a round, the
 * next round in the list follows (then the end). Transitions from one round are tried in order, the first whose
 * condition holds wins. `tie` = the two best totals are equal at the end of the round (teams if the game has
 * teams, else players) — typically → a tie-break round, which can loop on itself until the tie is broken.
 */
export const FlowCondition = z.enum(["always", "tie", "no-tie"]);
export type FlowCondition = z.infer<typeof FlowCondition>;

export const Transition = z.strictObject({
  from: RoundId,
  /** A round id, or "end" (game over). */
  to: z.union([RoundId, z.literal("end")]),
  when: FlowCondition.default("always"),
});
export type Transition = z.infer<typeof Transition>;

export const Format = z
  .strictObject({
    id: FormatId,
    name: z.string().min(1).max(200),
    participants: ParticipantsConfig,
    rounds: z.array(Round).min(1),
    tieBreak: z.enum(["speed", "control"]).default("control"),
    /** Absent or empty: rounds follow the list order. */
    flow: z.array(Transition).max(200).optional(),
    /** Node positions in the studio's flow editor (layout only, never read by the engine). */
    flowLayout: z.record(RoundId, z.strictObject({ x: z.number(), y: z.number() })).optional(),
  })
  .superRefine((f, ctx) => {
    const ids = new Set(f.rounds.map((r) => r.id));
    if (ids.size !== f.rounds.length) ctx.addIssue({ code: "custom", message: "identifiants de manches en double", path: ["rounds"] });
    for (const [i, t] of (f.flow ?? []).entries()) {
      if (!ids.has(t.from)) ctx.addIssue({ code: "custom", message: `enchaînement ${i} : manche de départ inconnue ${t.from}`, path: ["flow", i, "from"] });
      if (t.to !== "end" && !ids.has(t.to)) ctx.addIssue({ code: "custom", message: `enchaînement ${i} : manche d'arrivée inconnue ${t.to}`, path: ["flow", i, "to"] });
    }
  });
export type Format = z.infer<typeof Format>;
