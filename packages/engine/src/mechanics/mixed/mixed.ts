import { z } from "zod";
import { ScoringRule, type AnswerKind, type MechanicView } from "@quiz/schema";
import { defineMechanic } from "../../mechanic.ts";
import { assertNever, err } from "../../result.ts";

/**
 * « Mixte » round (ADR-0015): any question kind in the same round. It never runs a question itself: on
 * `question.present` the engine asks `route` which mechanic plays this question (by its answer kind) and with
 * which settings, and that mechanic goes on air (`GameState.mechanic.id` = the real one). Views, judging,
 * regrade, the renderer and the tablets therefore see an ordinary choice / poll-board / buzzer… question.
 * Round-level mechanics (ladder, board) are never used here: their progression spans the whole round.
 */
const allowChange = z.boolean().optional();
const scoring = ScoringRule.optional();

/**
 * Settings by question category (studio « Format », one block per category). Every key is optional: absent = the
 * flat key of older versions, else the mechanic's default. `scoring`: that category's own points rule (absent: the
 * round's). Survey and allocation decide their own points (no rule).
 */
export const MixedKinds = z.strictObject({
  choice: z.strictObject({ shuffleOptions: z.boolean().optional(), allowChange, partialMulti: z.boolean().optional(), race: z.number().int().min(0).max(1000).optional(), scoring }).optional(),
  vote: z.strictObject({ mode: z.enum(["none", "majority", "minority"]).optional(), shuffleOptions: z.boolean().optional(), allowChange, scoring }).optional(),
  poll: z.strictObject({ mode: z.enum(["per-answer", "bank"]).optional(), maxStrikes: z.number().int().min(1).max(10).optional(), multiplier: z.number().positive().max(100).optional(), steal: z.boolean().optional(), revealAll: z.boolean().optional() }).optional(),
  oral: z.strictObject({ lockoutOnWrong: z.boolean().optional(), scoring }).optional(),
  text: z.strictObject({ allowChange, typos: z.enum(["auto", "0", "1", "2", "3"]).optional(), scoring }).optional(),
  number: z.strictObject({ mode: z.enum(["tolerance", "closest"]).optional(), allowChange, tolerancePercent: z.number().min(0).max(100).optional(), winners: z.number().int().min(1).max(100).optional(), graded: z.boolean().optional(), scoring }).optional(),
  order: z.strictObject({ allowChange, partial: z.boolean().optional(), scoring }).optional(),
  pairs: z.strictObject({ allowChange, partial: z.boolean().optional(), scoring }).optional(),
  pin: z.strictObject({ allowChange, margin: z.number().min(0).max(50).optional(), scoring }).optional(),
  allocation: z.strictObject({ allowChange, keepOneEmpty: z.boolean().optional() }).optional(),
});
export type MixedKinds = z.infer<typeof MixedKinds>;
export type MixedCategory = keyof MixedKinds;

/** The settings category of each answer kind. */
export const MIXED_CATEGORY: Readonly<Record<AnswerKind, MixedCategory>> = {
  single: "choice",
  multi: "choice",
  boolean: "choice",
  vote: "vote",
  poll: "poll",
  oral: "oral",
  text: "text",
  number: "number",
  order: "order",
  pairs: "pairs",
  pin: "pin",
  allocation: "allocation",
};

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
  /** Settings by category (they win over the flat keys above, kept for older games). */
  kinds: MixedKinds.optional(),
});
export type MixedConfig = z.infer<typeof MixedConfig>;

/** Which mechanic plays each answer kind in a mixed round. */
export const MIXED_ROUTES: Readonly<Record<AnswerKind, string>> = {
  single: "choice",
  multi: "choice",
  boolean: "choice",
  vote: "choice",
  poll: "poll-board",
  oral: "buzzer",
  text: "text-answer",
  number: "number-answer",
  order: "order",
  pairs: "pairs",
  pin: "pin",
  allocation: "allocation",
};

/** Settings handed to the routed mechanic for a category: by-category value, else the flat key, else default. */
function routedConfig(cat: MixedCategory, c: MixedConfig): Record<string, unknown> {
  const k = c.kinds ?? {};
  switch (cat) {
    case "choice":
      return {
        shuffleOptions: k.choice?.shuffleOptions ?? c.shuffleOptions,
        allowChange: k.choice?.allowChange ?? c.allowChange,
        ...(k.choice?.partialMulti === undefined ? {} : { partialMulti: k.choice.partialMulti }),
        ...(k.choice?.race === undefined ? {} : { race: k.choice.race }),
      };
    case "vote":
      return { shuffleOptions: k.vote?.shuffleOptions ?? c.shuffleOptions, allowChange: k.vote?.allowChange ?? c.allowChange, vote: k.vote?.mode ?? "none" };
    case "number":
      return {
        allowChange: k.number?.allowChange ?? c.allowChange,
        mode: k.number?.mode ?? c.numberMode,
        ...(k.number?.tolerancePercent === undefined ? {} : { tolerancePercent: k.number.tolerancePercent }),
        ...(k.number?.winners === undefined ? {} : { winners: k.number.winners }),
        ...(k.number?.graded === undefined ? {} : { graded: k.number.graded }),
      };
    case "poll":
      return {
        maxStrikes: k.poll?.maxStrikes ?? c.pollMaxStrikes,
        multiplier: k.poll?.multiplier ?? c.pollMultiplier,
        scoring: k.poll?.mode ?? c.pollScoring,
        ...(k.poll?.steal === undefined ? {} : { steal: k.poll.steal }),
        ...(k.poll?.revealAll === undefined ? {} : { revealAll: k.poll.revealAll }),
      };
    case "allocation":
      return { allowChange: k.allocation?.allowChange ?? c.allowChange, keepOneEmpty: k.allocation?.keepOneEmpty ?? c.allocationKeepOneEmpty };
    case "oral":
      return { lockoutOnWrong: k.oral?.lockoutOnWrong ?? c.buzzerLockout };
    case "text":
      return { allowChange: k.text?.allowChange ?? c.allowChange, ...(k.text?.typos === undefined ? {} : { typos: k.text.typos }) };
    case "order":
    case "pairs":
      return { allowChange: k[cat]?.allowChange ?? c.allowChange, ...(k[cat]?.partial === undefined ? {} : { partial: k[cat].partial }) };
    case "pin":
      return { allowChange: k.pin?.allowChange ?? c.allowChange, ...(k.pin?.margin === undefined ? {} : { margin: k.pin.margin }) };
    default:
      return assertNever(cat);
  }
}

/** The points rule of a category, when it has its own. */
function categoryScoring(cat: MixedCategory, c: MixedConfig): ScoringRule | undefined {
  if (cat === "poll" || cat === "allocation") return undefined; // own points
  return c.kinds?.[cat]?.scoring;
}

const neverOnAir = (): never => {
  throw new Error("mixed round: the routed mechanic is on air, never « mixed » itself");
};

export const mixed = defineMechanic<MixedConfig, never>({
  id: "mixed",
  configSchema: MixedConfig,
  stateSchema: z.never(), // never on air: a snapshot claiming so is invalid → full replay
  route(cfg, question) {
    const kind = question.answerSpec.kind;
    const cat = MIXED_CATEGORY[kind];
    const own = categoryScoring(cat, cfg);
    return { id: MIXED_ROUTES[kind], config: routedConfig(cat, cfg), ...(own === undefined ? {} : { scoring: own }) };
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
