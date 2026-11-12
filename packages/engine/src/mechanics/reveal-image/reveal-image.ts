import { z } from "zod";
import { Media, type RevealImageMechanicView } from "@quiz/schema";
import { defineMechanic } from "../../mechanic.ts";
import { err, ok } from "../../result.ts";
import { isPrivileged, overrule } from "../shared/answers.ts";
import { correctOf, initCore, regradeCore, judgeCore, pointsAt, ProgressiveCore, removeFromCore, revealStep, submitCore } from "../shared/progressive.ts";

/**
 * Image revealed tile by tile (doc 03 `reveal-image`): the question image (`prompt.media`) is cut into
 * cols × rows tiles, uncovered in a seeded random order (`element.reveal { index }`, one tile at presentation).
 * The tablets never get the image (the base view drops `prompt.media` for players): it is shown masked on
 * the outputs only. Points: like `hints`, from `maxPoints` (one tile) down to `minPoints` (all tiles).
 */

export const RevealImageConfig = z
  .strictObject({
    cols: z.number().int().min(1).max(12).default(4),
    rows: z.number().int().min(1).max(12).default(3),
    maxPoints: z.number().int().min(0).max(1_000_000).default(100),
    minPoints: z.number().int().min(0).max(1_000_000).default(10),
    allowChange: z.boolean().default(false),
  })
  .refine((c) => c.minPoints <= c.maxPoints, "minPoints > maxPoints");
export type RevealImageConfig = z.infer<typeof RevealImageConfig>;

export const RevealImageState = ProgressiveCore.extend({
  image: Media,
  cols: z.number().int(),
  rows: z.number().int(),
  /** Tile reveal order (row-major indices), seeded. */
  order: z.array(z.number().int()),
});
export type RevealImageState = z.infer<typeof RevealImageState>;

export const revealImage = defineMechanic<RevealImageConfig, RevealImageState>({
  id: "reveal-image",
  configSchema: RevealImageConfig,
  stateSchema: RevealImageState,
  ownPoints: true,
  hidesPromptMedia: true,

  init(cfg, question, env) {
    const image = question.prompt.media;
    if (image === undefined || !image.mime.startsWith("image/")) return err("invalid", "la question n'a pas d'image");
    const total = cfg.cols * cfg.rows;
    const core = initCore({ maxPoints: cfg.maxPoints, minPoints: cfg.minPoints, allowChange: cfg.allowChange }, question, total, "reveal-image");
    if (!core.ok) return core;
    return ok({ ...core.value, image: { ...image }, cols: cfg.cols, rows: cfg.rows, order: env.rng.shuffle(Array.from({ length: total }, (_, i) => i)) });
  },

  submit: (s, pid, answer, env) => submitCore(s, pid, answer, env.at),

  onAction(s, a, env) {
    if (a.type === "element.reveal") return revealStep(s, a.index, env.phase);
    if (a.type === "answer.judge") return overrule(s, a.participantId, a.correct, env.phase);
    return null;
  },

  judge: judgeCore,
  regrade: regradeCore,
  endsRound: () => false,
  closeRound: () => [],
  removeParticipant: removeFromCore,
  answerOf: (s, pid) => s.answers.find((a) => a.participantId === pid)?.value ?? null,
  answers: (s) => s.answers.map((a) => ({ participantId: a.participantId, optionIds: a.value, at: a.at })),

  project(s, env): RevealImageMechanicView {
    const revealed = env.phase === "revealed";
    return {
      mechanic: "reveal-image",
      image: env.audience === "player" ? null : { ...s.image },
      aspect: s.image.w !== undefined && s.image.h !== undefined ? s.image.w / s.image.h : null,
      cols: s.cols,
      rows: s.rows,
      revealed: revealed ? Array.from({ length: s.total }, (_, i) => i) : s.order.slice(0, s.shown).toSorted((a, b) => a - b),
      points: pointsAt(s, s.shown),
      input: s.input,
      options: s.input === "choice" ? s.options.map((o) => ({ ...o })) : null,
      correct: revealed || isPrivileged(env.audience) ? correctOf(s) : null,
      answeredCount: env.audience === "player" ? null : s.answers.length,
    };
  },
});
