import { z } from "zod";
import { Media, NormRect, type PinMechanicView, unsupportedQuestion } from "@quiz/schema";
import { defineMechanic, type Judgement } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { answerOfStored, answersOfStored, isPrivileged, Overrule, overrule, showsResults, storeAnswer, StoredAnswer, verdict } from "../shared/answers.ts";

/**
 * Pin (doc 03 `pin`): tap the right spot on the question image (map, photo, painting). Right = inside the
 * target zone (normalised 0..1). Pins are shown anonymously at the reveal. Answer text form: ["x,y"].
 */

export const PinConfig = z.strictObject({ allowChange: z.boolean().default(true) });
export type PinConfig = z.infer<typeof PinConfig>;

export const PinState = z.strictObject({
  image: Media.nullable(),
  target: NormRect,
  allowChange: z.boolean(),
  answers: z.array(StoredAnswer),
  overrules: z.array(Overrule),
});
export type PinState = z.infer<typeof PinState>;

const point = (a: StoredAnswer): { x: number; y: number } => {
  const [x, y] = (a.value[0] ?? "0,0").split(",").map(Number);
  return { x: x ?? 0, y: y ?? 0 };
};
const inside = (t: NormRect, p: { x: number; y: number }): boolean => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h;
/** 4 decimals: 0.1 px on a 1920 px image, and a short, stable text form. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

const pinsCache = new WeakMap<PinState, { x: number; y: number; hit: boolean }[]>();
/** Computed once per state, shared by every projection. */
function pinsOf(s: PinState): { x: number; y: number; hit: boolean }[] {
  let p = pinsCache.get(s);
  if (p === undefined) {
    p = s.answers.map((a) => ({ ...point(a), hit: verdict(s.overrules, a.participantId, inside(s.target, point(a))) }));
    pinsCache.set(s, p);
  }
  return p;
}

export const pin = defineMechanic<PinConfig, PinState>({
  id: "pin",
  configSchema: PinConfig,
  stateSchema: PinState,

  init(cfg, question) {
    const a = question.answerSpec;
    if (a.kind !== "pin") return err("unsupported", unsupportedQuestion("pin", a.kind));
    const image = question.prompt.media;
    if (image === undefined || !image.mime.startsWith("image/")) return err("invalid", "la question n'a pas d'image sur laquelle viser");
    return ok({ image: { ...image }, target: { ...a.target }, allowChange: cfg.allowChange, answers: [], overrules: [] });
  },

  submit(s, participantId, answer, env) {
    if (answer.kind !== "pin") return err("invalid", "un point sur l'image est attendu");
    return storeAnswer(s, participantId, [`${round4(answer.x)},${round4(answer.y)}`], env.at);
  },

  onAction(s, a, env) {
    if (a.type !== "answer.judge") return null;
    return overrule(s, a.participantId, a.correct, env.phase);
  },

  regrade(s, question) {
    const a = question.answerSpec;
    return a.kind === "pin" ? ok({ ...s, target: { ...a.target } }) : err("invalid", "type de réponse différent");
  },

  judge(s): Judgement[] {
    return s.answers.map((a) => ({ kind: "rule", participantId: a.participantId, outcome: verdict(s.overrules, a.participantId, inside(s.target, point(a))) ? "correct" : "wrong", answeredAt: a.at }));
  },

  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: (s, pid) => ({ ...s, answers: s.answers.filter((a) => a.participantId !== pid), overrules: s.overrules.filter((o) => o.participantId !== pid) }),
  answerOf: (s, pid) => answerOfStored(s.answers, pid),
  answers: (s) => answersOfStored(s.answers),

  project(s, env): PinMechanicView {
    return {
      mechanic: "pin",
      image: s.image === null ? null : { ...s.image },
      correct: isPrivileged(env.audience) || env.phase === "revealed" ? { ...s.target } : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
      // Outputs / host / control only: 500 pins in every tablet view would be ~10 MB per broadcast.
      pins: env.audience !== "player" && showsResults(env.audience, env.phase) ? pinsOf(s) : null,
    };
  },
});
