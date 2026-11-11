import type { Layer, MechanicView, Phase, Theme, View, ZoneState } from "@quiz/schema";

/**
 * Pure helpers of the renderer (unit-tested without a DOM). Zones only read their bound data and a state;
 * no game rule lives here — states are read off the projected view.
 */

/** Reads a dot path (`question.prompt.text`, `leaderboard.0.total`) in a view. Unknown path → undefined. */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
    } else if (typeof cur === "object") {
      if (!Object.hasOwn(cur, part)) return undefined;
      cur = (cur as Record<string, unknown>)[part]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- generic JSON walk, own key checked
    } else return undefined;
  }
  return cur;
}

/** Is a layer on screen? `auto`: by phase. `manual` / `auto-hold`: TAKEN by the control room (view.layers). */
export function layerVisible(layer: Layer, phase: Phase, taken: Readonly<Record<string, boolean>>): boolean {
  switch (layer.mode) {
    case "auto":
      return layer.phases.length === 0 || layer.phases.includes(phase);
    case "manual":
      return taken[layer.id] === true;
    case "auto-hold":
      return taken[layer.id] === true && (layer.phases.length === 0 || layer.phases.includes(phase));
    default:
      return false;
  }
}

/** State of one answer option, for styling (doc 02 ZoneState). */
export function optionState(m: MechanicView, optionId: string, myAnswer: readonly string[] | null): ZoneState {
  if (m.mechanic !== "choice") return "idle";
  if (m.correct !== null && m.counts !== null) return m.correct.includes(optionId) ? "correct" : "wrong";
  if (myAnswer?.includes(optionId) === true) return "selected";
  return "idle";
}

/** Share of answers per option once counts are public (0..1), null before. */
export function optionShare(m: MechanicView, optionId: string): number | null {
  if (m.mechanic !== "choice" || m.counts === null) return null;
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : (m.counts[optionId] ?? 0) / total;
}

/** Whole seconds left, never negative. `serverNow` comes from the protocol client clock estimate. */
export function secondsLeft(endsAt: number, serverNow: number): number {
  return Math.max(0, Math.ceil((endsAt - serverNow) / 1000));
}

/** Theme tokens → CSS custom properties `--q-…` (doc CONVENTIONS "Front"). */
export function themeVars(t: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.colors)) vars[`--q-color-${k.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v;
  vars["--q-font"] = t.font.family;
  vars["--q-font-weight"] = String(t.font.weight);
  vars["--q-radius"] = `${t.radius}px`;
  vars["--q-motion"] = MOTION_MS[t.motion];
  return vars;
}

const MOTION_MS: Record<Theme["motion"], string> = { snappy: "180ms", elegant: "420ms", bouncy: "320ms", dramatic: "700ms" };

/** Letters A, B, C… for option badges. */
export const optionLetter = (i: number): string => String.fromCharCode(65 + (i % 26));

/** Font size that makes `text` fit a box (approximation used before the DOM measure, and in tests). */
export function estimateFontSize(text: string, box: { w: number; h: number }, max: number, min = 18): number {
  for (let size = max; size > min; size -= 2) {
    const charsPerLine = Math.max(1, Math.floor(box.w / (size * 0.55)));
    const lines = Math.ceil(text.length / charsPerLine);
    if (lines * size * 1.2 <= box.h) return size;
  }
  return min;
}

export type AnyView = View;
