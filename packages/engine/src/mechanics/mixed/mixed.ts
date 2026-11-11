import { z } from "zod";
import type { AnswerKind, MechanicView } from "@quiz/schema";
import { defineMechanic } from "../../mechanic.ts";
import { err } from "../../result.ts";

/**
 * « Mixte » round (ADR-0015): any question kind in the same round. It never runs a question itself: on
 * `question.present` the engine asks `route` which mechanic plays this question (by its answer kind) and with
 * which settings, and that mechanic goes on air (`GameState.mechanic.id` = the real one). Views, judging,
 * regrade, the renderer and the tablets therefore see an ordinary choice / poll-board / buzzer… question.
 * Round-level mechanics (ladder, board) are never used here: their progression spans the whole round.
 */
export const MixedConfig = z.strictObject({
  /** QCM: shuffle the options (seeded, same order for everyone). */
  shuffleOptions: z.boolean().default(false),
  /** Tablet answers may change until the lock (QCM, free text, number, order, pairs, pin, allocation). */
  allowChange: z.boolean().default(true),
  /** Survey: wrong answers before the hand passes (Family-Feud-like). */
  pollMaxStrikes: z.number().int().min(1).max(10).default(3),
  /** Survey: bank multiplier (double / triple round). */
  pollMultiplier: z.number().positive().max(100).default(1),
  /** Survey: `per-answer` (each team scores what it finds) or `bank` (TV rule). Default kept for older journals. */
  pollScoring: z.enum(["per-answer", "bank"]).default("bank"),
  /** Allocation: at least one answer must be left empty. */
  allocationKeepOneEmpty: z.boolean().default(true),
  /** Number: right within the question's tolerance, or only the closest win. */
  numberMode: z.enum(["tolerance", "closest"]).default("tolerance"),
  /** Spoken answer (buzzer): a player who was wrong cannot buzz again on the same question. */
  buzzerLockout: z.boolean().default(true),
});
export type MixedConfig = z.infer<typeof MixedConfig>;

/** Which mechanic plays each answer kind in a mixed round. */
export const MIXED_ROUTES: Readonly<Record<AnswerKind, string>> = {
  single: "choice",
  multi: "choice",
  boolean: "choice",
  poll: "poll-board",
  oral: "buzzer",
  text: "text-answer",
  number: "number-answer",
  order: "order",
  pairs: "pairs",
  pin: "pin",
  allocation: "allocation",
};

/** Settings handed to the routed mechanic (its own defaults for the rest). */
function routedConfig(id: string, c: MixedConfig): Record<string, unknown> {
  switch (id) {
    case "choice":
      return { shuffleOptions: c.shuffleOptions, allowChange: c.allowChange };
    case "number-answer":
      return { allowChange: c.allowChange, mode: c.numberMode };
    case "poll-board":
      return { maxStrikes: c.pollMaxStrikes, multiplier: c.pollMultiplier, scoring: c.pollScoring };
    case "allocation":
      return { allowChange: c.allowChange, keepOneEmpty: c.allocationKeepOneEmpty };
    case "buzzer":
      return { lockoutOnWrong: c.buzzerLockout };
    case "text-answer":
    case "order":
    case "pairs":
    case "pin":
      return { allowChange: c.allowChange };
    default:
      return {};
  }
}

const neverOnAir = (): never => {
  throw new Error("mixed round: the routed mechanic is on air, never « mixed » itself");
};

export const mixed = defineMechanic<MixedConfig, never>({
  id: "mixed",
  configSchema: MixedConfig,
  stateSchema: z.never(), // never on air: a snapshot claiming so is invalid → full replay
  route(cfg, question) {
    const id = MIXED_ROUTES[question.answerSpec.kind];
    return { id, config: routedConfig(id, cfg) };
  },
  init: () => err("unsupported", "manche mixte : la question est jouée par le type qui lui correspond"),
  submit: neverOnAir,
  onAction: () => null,
  judge: () => [],
  endsRound: () => false,
  closeRound: () => [],
  answerOf: () => null,
  removeParticipant: neverOnAir,
  answers: () => [],
  project: (): MechanicView => neverOnAir(),
});
