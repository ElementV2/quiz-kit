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

export type ChoiceView = Extract<MechanicView, { mechanic: "choice" }>;
export type PollBoardView = Extract<MechanicView, { mechanic: "poll-board" }>;
export type BuzzerView = Extract<MechanicView, { mechanic: "buzzer" }>;
export type LadderView = Extract<MechanicView, { mechanic: "ladder" }>;
/** Narrowing helpers (one per mechanic view): use them in `<Show when={asChoice(v.mechanic)}>`. */
export const asChoice = (m: MechanicView | null | undefined): ChoiceView | null => (m?.mechanic === "choice" ? m : null);
export const asPollBoard = (m: MechanicView | null | undefined): PollBoardView | null => (m?.mechanic === "poll-board" ? m : null);
export const asBuzzer = (m: MechanicView | null | undefined): BuzzerView | null => (m?.mechanic === "buzzer" ? m : null);
export const asLadder = (m: MechanicView | null | undefined): LadderView | null => (m?.mechanic === "ladder" ? m : null);

/** State of one answer option, for styling (doc 02 ZoneState). */
export function optionState(m: MechanicView, optionId: string, myAnswer: readonly string[] | null, phase?: Phase): ZoneState {
  switch (m.mechanic) {
    case "choice":
      if (m.correct !== null && m.counts !== null) return m.correct.includes(optionId) ? "correct" : "wrong";
      return myAnswer?.includes(optionId) === true ? "selected" : "idle";
    case "ladder":
      // `correct` is public only once revealed (host / control see it earlier but the candidate's answer matters).
      if (m.hidden.includes(optionId)) return "disabled";
      // Host / control know `correct` early: only style it once revealed (or once the ladder is over).
      if (m.correct !== null && (phase === "revealed" || m.status !== "playing")) return m.correct === optionId ? "correct" : m.answer === optionId ? "wrong" : "idle";
      return m.answer === optionId ? "selected" : "idle";
    case "buzzer":
      if (m.correct !== null && m.winner !== null) return m.correct === optionId ? "correct" : "idle";
      return "idle";
    case "poll-board":
      return "idle";
    default:
      return "idle";
  }
}

/** Options shown as an answer list: choice, ladder, buzzer with options. */
export function optionsOf(m: MechanicView | null): readonly { id: string; label: string }[] {
  if (m === null) return [];
  switch (m.mechanic) {
    case "choice":
    case "ladder":
      return m.options;
    case "buzzer":
      return m.options ?? [];
    case "poll-board":
      return [];
    default:
      return [];
  }
}

/** Share of answers per option once counts are public (0..1), null before. */
export function optionShare(m: MechanicView, optionId: string): number | null {
  if (m.mechanic === "ladder") return m.audience === null ? null : (m.audience[optionId] ?? 0) / 100; // audience joker (%)
  if (m.mechanic !== "choice" || m.counts === null) return null;
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : (m.counts[optionId] ?? 0) / total;
}

/** Display name of a participant from the board carried by every view. */
export function nameOf(v: { leaderboard: readonly { participantId: string; displayName: string }[] }, id: string | null): string {
  if (id === null) return "";
  return v.leaderboard.find((r) => r.participantId === id)?.displayName ?? "?";
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
