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
export type TextAnswerView = Extract<MechanicView, { mechanic: "text-answer" }>;
export type NumberAnswerView = Extract<MechanicView, { mechanic: "number-answer" }>;
export type OrderView = Extract<MechanicView, { mechanic: "order" }>;
export type PairsView = Extract<MechanicView, { mechanic: "pairs" }>;
export type PinView = Extract<MechanicView, { mechanic: "pin" }>;
export type AllocationView = Extract<MechanicView, { mechanic: "allocation" }>;
export type BoardView = Extract<MechanicView, { mechanic: "board" }>;
export type HintsView = Extract<MechanicView, { mechanic: "hints" }>;
export type RevealImageView = Extract<MechanicView, { mechanic: "reveal-image" }>;
export const asTextAnswer = (m: MechanicView | null | undefined): TextAnswerView | null => (m?.mechanic === "text-answer" ? m : null);
export const asNumberAnswer = (m: MechanicView | null | undefined): NumberAnswerView | null => (m?.mechanic === "number-answer" ? m : null);
export const asOrder = (m: MechanicView | null | undefined): OrderView | null => (m?.mechanic === "order" ? m : null);
export const asPairs = (m: MechanicView | null | undefined): PairsView | null => (m?.mechanic === "pairs" ? m : null);
export const asPin = (m: MechanicView | null | undefined): PinView | null => (m?.mechanic === "pin" ? m : null);
export const asAllocation = (m: MechanicView | null | undefined): AllocationView | null => (m?.mechanic === "allocation" ? m : null);
export const asBoard = (m: MechanicView | null | undefined): BoardView | null => (m?.mechanic === "board" ? m : null);
export const asHints = (m: MechanicView | null | undefined): HintsView | null => (m?.mechanic === "hints" ? m : null);
export const asRevealImage = (m: MechanicView | null | undefined): RevealImageView | null => (m?.mechanic === "reveal-image" ? m : null);
export type CrowdVoteView = Extract<MechanicView, { mechanic: "crowd-vote" }>;
export const asCrowdVote = (m: MechanicView | null | undefined): CrowdVoteView | null => (m?.mechanic === "crowd-vote" ? m : null);

/** State of one answer option, for styling (doc 02 ZoneState). */
export function optionState(m: MechanicView, optionId: string, myAnswer: readonly string[] | null, phase?: Phase): ZoneState {
  switch (m.mechanic) {
    case "choice":
      // A vote has no wrong answer: the winning choice(s) stand out, the others stay neutral.
      if (m.kind === "vote" && m.correct !== null && m.counts !== null) return m.correct.includes(optionId) ? "correct" : "idle";
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
    case "allocation":
      if (m.correct !== null && phase === "revealed") return m.correct === optionId ? "correct" : "idle";
      return "idle";
    case "hints":
    case "reveal-image":
      if (m.input === "choice" && m.correct !== null && phase === "revealed") return m.correct === optionId ? "correct" : myAnswer?.includes(optionId) === true ? "wrong" : "idle";
      return myAnswer?.includes(optionId) === true ? "selected" : "idle";
    case "crowd-vote":
      if (phase !== "revealed") return "idle";
      if (m.correct !== null) return m.correct === optionId ? "correct" : m.majority?.includes(optionId) === true ? "wrong" : "idle";
      return m.majority?.includes(optionId) === true ? "correct" : "idle";
    case "board":
      // `correct` is the right option's label: the option list styles it once someone won the cell.
      if (m.correct !== null && m.winner !== null) return m.options?.find((o) => o.id === optionId)?.label === m.correct ? "correct" : "idle";
      return "idle";
    case "poll-board":
    case "text-answer":
    case "number-answer":
    case "order":
    case "pairs":
    case "pin":
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
    case "board":
    case "hints":
    case "reveal-image":
      return m.options ?? [];
    case "allocation":
    case "crowd-vote":
      return m.options;
    case "poll-board":
    case "text-answer":
    case "number-answer":
    case "order":
    case "pairs":
    case "pin":
      return [];
    default:
      return [];
  }
}

/** Share of answers per option once counts are public (0..1), null before. */
export function optionShare(m: MechanicView, optionId: string): number | null {
  if (m.mechanic === "ladder") return m.audience === null ? null : (m.audience[optionId] ?? 0) / 100; // audience joker (%)
  if ((m.mechanic !== "choice" && m.mechanic !== "allocation") || m.counts === null) return null;
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
export function themeVars(t: Theme, mediaUrl: (hash: string) => string = (h) => `/media/${h}`): Record<string, string> {
  const vars: Record<string, string> = { ...MATERIALS[t.material] };
  vars["--q-logo"] = t.logo === undefined ? "none" : `url(${mediaUrl(t.logo)})`;
  for (const [k, v] of Object.entries(t.colors)) vars[`--q-color-${k.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v;
  vars["--q-font"] = t.font.family;
  vars["--q-font-weight"] = String(t.font.weight);
  vars["--q-radius"] = `${t.radius}px`;
  vars["--q-motion"] = MOTION_MS[t.motion];
  return vars;
}

const FLAT = { "--q-mat-image": "none", "--q-mat-size": "auto", "--q-mat-border": "none", "--q-mat-backdrop": "none", "--q-mat-shadow": "0 10px 30px rgba(0,0,0,.35)" };

/**
 * Frame materials (doc 06), drawn over the state colour so correct / selected / wrong keep working.
 * CSS only (gradients, borders, shadows): no `color-mix()` — vMix's Chromium version is unknown (OPEN-QUESTIONS).
 */
export const MATERIALS: Record<Theme["material"], Record<string, string>> = {
  flat: FLAT,
  gradient: { ...FLAT, "--q-mat-image": "linear-gradient(180deg, rgba(255,255,255,.18), rgba(0,0,0,.24))" },
  glass: { ...FLAT, "--q-mat-image": "linear-gradient(135deg, rgba(255,255,255,.24), rgba(255,255,255,.04) 60%)", "--q-mat-border": "1px solid rgba(255,255,255,.3)", "--q-mat-backdrop": "blur(14px) saturate(1.3)", "--q-mat-shadow": "0 8px 32px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.35)" },
  metal: { ...FLAT, "--q-mat-image": "linear-gradient(180deg, rgba(255,255,255,.38) 0%, rgba(255,255,255,.06) 48%, rgba(0,0,0,.2) 52%, rgba(255,255,255,.14) 100%)", "--q-mat-border": "2px solid rgba(255,255,255,.45)", "--q-mat-shadow": "0 6px 18px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.6)" },
  neon: { ...FLAT, "--q-mat-border": "2px solid var(--q-color-accent)", "--q-mat-shadow": "0 0 10px var(--q-color-accent), 0 0 28px var(--q-color-accent), inset 0 0 14px var(--q-color-accent)" },
  paper: { ...FLAT, "--q-mat-image": "repeating-linear-gradient(0deg, rgba(0,0,0,.04) 0 2px, transparent 2px 4px), linear-gradient(180deg, rgba(255,255,255,.1), rgba(0,0,0,.1))", "--q-mat-shadow": "0 2px 0 rgba(0,0,0,.3), 0 12px 24px rgba(0,0,0,.25)" },
  led: { ...FLAT, "--q-mat-image": "radial-gradient(circle, rgba(255,255,255,.16) 1.2px, transparent 1.8px)", "--q-mat-size": "6px 6px", "--q-mat-border": "2px solid rgba(0,0,0,.6)" },
};

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

type SidesView = { readonly teamBoard: readonly { teamId: string; name: string }[]; readonly leaderboard: readonly { participantId: string; displayName: string; teamId?: string | null }[] };

/** Survey sides: the teams, then the players without a team (all players in a game played individually). */
export function pollSides(v: SidesView): { id: string; name: string }[] {
  const teams = v.teamBoard.map((t) => ({ id: t.teamId, name: t.name }));
  const solo = v.leaderboard.filter((r) => teams.length === 0 || r.teamId === null || r.teamId === undefined).map((r) => ({ id: r.participantId, name: r.displayName }));
  return [...teams, ...solo];
}

/** Name of a survey side (team `t_…` or player `p_…`). */
export function sideName(v: SidesView, id: string | null): string {
  if (id === null) return "—";
  return v.teamBoard.find((t) => t.teamId === id)?.name ?? v.leaderboard.find((r) => r.participantId === id)?.displayName ?? "—";
}

/** `poll.control` / `poll.steal` for a side (the id prefix tells a team from a player). */
export function pollSideAction(type: "poll.control" | "poll.steal", id: string): { type: "poll.control" | "poll.steal"; teamId?: string; participantId?: string } {
  return id.startsWith("p_") ? { type, participantId: id } : { type, teamId: id };
}

