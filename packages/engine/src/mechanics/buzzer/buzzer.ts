import { z } from "zod";
import { Media, OptionId, ParticipantId, type ActionOf, type BuzzerMechanicView } from "@quiz/schema";
import { defineMechanic, type Judgement, type MechanicEnv } from "../../mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "../../result.ts";

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
  buzzes: z.array(z.strictObject({ participantId: ParticipantId, at: z.number().int(), status: z.enum(["waiting", "correct", "wrong"]) })),
});
export type BuzzerState = z.infer<typeof BuzzerState>;

type S = BuzzerState;
type R = Result<S, Rejection>;

const winnerOf = (s: S): string | null => s.buzzes.find((b) => b.status === "correct")?.participantId ?? null;
const queueOf = (s: S): string[] => s.buzzes.filter((b) => b.status === "waiting").map((b) => b.participantId);
const handOf = (s: S): string | null => (winnerOf(s) === null ? (queueOf(s)[0] ?? null) : null);
const isLockedOut = (s: S, pid: string): boolean => s.lockoutOnWrong && s.buzzes.some((b) => b.participantId === pid && b.status === "wrong");
const lockedOutOf = (s: S): string[] => (s.lockoutOnWrong ? [...new Set(s.buzzes.filter((b) => b.status === "wrong").map((b) => b.participantId))] : []);

/** Phase `open` is checked by the core; the participant is known and active. */
function onBuzz(s: S, a: ActionOf<"buzz">, env: MechanicEnv): R {
  if (winnerOf(s) !== null) return err("conflict", "question déjà gagnée");
  if (s.buzzes.some((b) => b.participantId === a.participantId && b.status === "waiting")) return err("conflict", "déjà dans la file");
  if (isLockedOut(s, a.participantId)) return err("forbidden", "joueur bloqué pour cette question");
  return ok({ ...s, buzzes: [...s.buzzes, { participantId: a.participantId, at: env.at, status: "waiting" }] });
}

function onJudge(s: S, a: ActionOf<"answer.judge">, env: MechanicEnv): R {
  if (env.phase !== "open" && env.phase !== "locked" && env.phase !== "judging") return err("wrong-phase", "aucune réponse à juger");
  if (a.participantId === undefined) return err("invalid", "préciser le joueur jugé (participantId)");
  const hand = handOf(s);
  if (hand === null) return err("conflict", "personne n'a la main");
  if (hand !== a.participantId) return err("conflict", "ce joueur n'a pas la main");
  const status = a.correct ? "correct" : "wrong";
  // The hand is the first waiting buzz: update exactly that one.
  const i = s.buzzes.findIndex((b) => b.status === "waiting");
  return ok({ ...s, buzzes: s.buzzes.map((b, j) => (j === i ? { ...b, status } : b)) });
}

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
      case "multi":
      case "boolean":
      case "poll":
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
    const pid = env.audience === "player" ? env.participantId : null;
    let me: BuzzerMechanicView["me"] = null;
    if (env.audience === "player" && pid !== null) {
      const pos = queue.indexOf(pid);
      const lockedOut = isLockedOut(s, pid);
      me = { hasHand: hand === pid, queuePosition: pos < 0 ? null : pos + 1, lockedOut, canBuzz: env.phase === "open" && winner === null && pos < 0 && !lockedOut };
    }
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
