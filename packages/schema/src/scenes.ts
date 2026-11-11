import { z } from "zod";
import { Phase } from "./phase.ts";

/**
 * Scenes & themes (doc 02 "Scène et habillage", doc 06). A scene is a fixed-size canvas of layers of zones;
 * each zone reads ONE bound value of the projected view (`bind`, dot path) and knows nothing about the game.
 */

export const ZoneType = z.enum([
  "question", // bound: question prompt
  "question-media", // bound: question.prompt.media (image, video, audio — blind test)
  "answer-list", // repeat over the mechanic options (choice) — item state: idle | selected | correct | wrong
  "timer", // bound: view.timer (countdown from server time)
  "leaderboard", // bound: view.leaderboard
  "round-info", // round title + question index
  "answer-count", // live number of answers (outputs / host)
  "text", // static text (props.text) or bound value
  "image", // static image (props.src) — media store arrives in phase 2
]);
export type ZoneType = z.infer<typeof ZoneType>;

export const Rect = z.strictObject({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
export type Rect = z.infer<typeof Rect>;

export const ZoneState = z.enum(["hidden", "masked", "revealed", "selected", "locked", "correct", "wrong", "disabled", "idle"]);
export type ZoneState = z.infer<typeof ZoneState>;

/** CSS declarations (property → value) applied in a given state. Rendered as inline styles, never as HTML. */
export const StyleMap = z.record(z.string().regex(/^[a-z-]+$/), z.string().max(200));

export const Zone = z.strictObject({
  id: z.string().regex(/^[0-9a-z-]+$/),
  type: ZoneType,
  rect: Rect,
  /** Dot path into the view (`question.prompt.text`). Zone types have a sensible default. */
  bind: z.string().regex(/^[A-Za-z0-9_.]+$/).optional(),
  /** Type-specific options (columns, maxRows, text…), validated loosely here and by the zone component. */
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  style: StyleMap.default({}),
  states: z.partialRecord(ZoneState, StyleMap).default({}),
});
export type Zone = z.infer<typeof Zone>;

export const LayerMode = z.enum(["auto", "manual", "auto-hold"]);

export const Layer = z.strictObject({
  id: z.string().regex(/^[0-9a-z-]+$/),
  name: z.string().min(1),
  /** Stacking order (doc 06: background 0, set 10, scores 20, leaderboard 30, info 40, timer 50, fullscreen 90). */
  z: z.number().int(),
  mode: LayerMode.default("auto"),
  /** `auto`: visible in these phases (empty = always). `manual`: visible when the control room TAKEs it. */
  phases: z.array(Phase).default([]),
  zones: z.array(Zone),
});
export type Layer = z.infer<typeof Layer>;

export const Scene = z.strictObject({
  id: z.string().regex(/^[0-9a-z-]+$/),
  name: z.string().min(1),
  size: z.strictObject({ w: z.number().int().positive(), h: z.number().int().positive() }).default({ w: 1920, h: 1080 }),
  layers: z.array(Layer),
});
export type Scene = z.infer<typeof Scene>;

const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

/** Theme tokens (doc 06). Rendered as CSS variables `--q-…`. */
export const Theme = z.strictObject({
  id: z.string(),
  name: z.string(),
  colors: z.strictObject({
    surface: Color,
    surfaceAlt: Color,
    text: Color,
    muted: Color,
    primary: Color,
    accent: Color,
    correct: Color,
    wrong: Color,
    selected: Color,
  }),
  font: z.strictObject({ family: z.string(), weight: z.number().int().min(100).max(900) }),
  radius: z.number().min(0).max(64),
  motion: z.enum(["snappy", "elegant", "bouncy", "dramatic"]),
});
export type Theme = z.infer<typeof Theme>;
