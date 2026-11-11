import { z } from "zod";
import { Media, OptionId, type BuzzerMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { assertNever, err, ok } from "../../result.ts";
import { Buzz, buzzMe, handOf, lockedOutOf, onBuzz, onJudge, queueOf, winnerOf } from "../shared/buzz-queue.ts";

/**
 * Buzzer (culture G, doc 03). Answers open = buzzers open. Each `buzz` joins the queue in journal order:
 * the first journaled buzz has the hand. Control / host judge whoever has the hand
 * (`answer.judge { participantId, correct }`): wrong → the player leaves the queue (locked out for the
 * question if `lockoutOnWrong`), the hand passes to the next one; right → buzzers close for the question.
 * Points come from the round's ScoringRule on `question.reveal` (base for the right answer, penalty for
 * each wrong one, timeDecay measured at the buzz).
 */

export const BuzzerConfig = z.strictObject({
  /** A wrong player cannot buzz again on the same question. */
  lockoutOnWrong: z.boolean().default(true),
});
export type BuzzerConfig = z.infer<typeof BuzzerConfig>;

export const BuzzerState = z.strictObject({
  kind: z.enum(["oral", "single"]),
  /** Spoken options (`single`), empty for `oral`. */
  options: z.array(z.strictObject({ id: OptionId, label: z.string(), media: Media.optional() })),
  correct: OptionId.nullable(),
  expected: z.string().nullable(),
  lockoutOnWrong: z.boolean(),
  /** Every buzz, in journal order. `waiting` ones form the queue. */
  buzzes: z.array(Buzz),
});
export type BuzzerState = z.infer<typeof BuzzerState>;

export const buzzer = defineMechanic<BuzzerConfig, BuzzerState>({
  id: "buzzer",
  configSchema: BuzzerConfig,
  stateSchema: BuzzerState,

  init(cfg, question) {
    const spec = question.answerSpec;
    const common = { lockoutOnWrong: cfg.lockoutOnWrong, buzzes: [] };
    switch (spec.kind) {
      case "oral":
        return ok({ kind: "oral", options: [], correct: null, expected: spec.expected, ...common });
      case "single":
        return ok({ kind: "single", options: spec.options.map(({ id, label, media }) => (media ? { id, label, media } : { id, label })), correct: spec.correct, expected: null, ...common });
      case "text":
        // A free-text question read out by the host: the canonical answer is what the host expects.
        return ok({ kind: "oral", options: [], correct: null, expected: spec.accepted[0] ?? "", ...common });
      case "multi":
      case "boolean":
      case "poll":
      case "number":
      case "order":
      case "pairs":
      case "pin":
      case "allocation":
        return err("unsupported", `la mécanique buzzer ne gère pas les questions ${spec.kind}`);
      default:
        return assertNever(spec);
    }
  },

  submit() {
    return err("unsupported", "buzzer : buzzer d'abord, la réponse est donnée oralement");
  },

  onAction(s, a, env) {
    if (a.type === "buzz") return onBuzz(s, a, env);
    if (a.type === "answer.judge") return onJudge(s, a, env);
    return null;
  },

  judge(s): Judgement[] {
    return s.buzzes.flatMap((b): Judgement[] => (b.status === "waiting" ? [] : [{ kind: "rule", participantId: b.participantId, outcome: b.status, answeredAt: b.at }]));
  },

  endsRound() {
    return false;
  },

  closeRound() {
    return [];
  },

  removeParticipant(s, participantId) {
    return { ...s, buzzes: s.buzzes.filter((b) => b.participantId !== participantId) };
  },

  answerOf() {
    return null; // nothing typed: the player's buzzer state is in the mechanic view (`me`)
  },

  answers(s) {
    return s.buzzes.map((b) => ({ participantId: b.participantId, optionIds: [], at: b.at }));
  },

  project(s, env): BuzzerMechanicView {
    const secrets = env.phase === "revealed" || env.audience === "host" || env.audience === "control";
    const queue = queueOf(s);
    const hand = handOf(s);
    const winner = winnerOf(s);
    const me: BuzzerMechanicView["me"] = buzzMe(s, env.audience, env.participantId, env.phase);
    const light = env.audience === "player";
    return {
      mechanic: "buzzer",
      kind: s.kind,
      options: s.kind === "single" ? s.options.map((o) => ({ ...o })) : null,
      correct: secrets ? s.correct : null,
      expected: secrets ? s.expected : null,
      hand,
      winner,
      queue: light ? null : queue,
      lockedOut: light ? null : lockedOutOf(s),
      me,
    };
  },
});
