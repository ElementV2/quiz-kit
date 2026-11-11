import type { AnswerSpec, HostView, Phase, Rundown } from "@quiz/schema";

/**
 * Run-down helpers shared by the control room and the host (pure, unit-tested). They only LOCATE questions
 * in the projected run-down and put an answer into words: the next question, phases and verdicts all come
 * from the view (the engine decides).
 */

/** Same as the renderer's `formatNumber` (kept here so this module stays free of JSX imports). */
const formatNumber = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 6 });

export type RundownRound = Rundown[number];
export type RundownQuestion = RundownRound["questions"][number];
export type Target = { readonly roundIndex: number; readonly questionIndex: number };

/** Phases where a question is on screen (presented, open, locked, judged or revealed). */
export const ON_AIR_PHASES: ReadonlySet<Phase> = new Set<Phase>(["presenting", "open", "locked", "judging", "revealed"]);

type Locatable = Pick<HostView, "phase" | "round" | "question" | "nextQuestion" | "rundown"> & { readonly cursor?: HostView["cursor"] };

export const questionAt = (rundown: Rundown, t: Target | null): RundownQuestion | null =>
  t === null ? null : (rundown[t.roundIndex]?.questions.find((q) => q.index === t.questionIndex) ?? null);

export const sameTarget = (a: Target | null, b: Target | null): boolean =>
  a !== null && b !== null && a.roundIndex === b.roundIndex && a.questionIndex === b.questionIndex;

/** The question on screen, if any. */
export function onAirTarget(v: Locatable): Target | null {
  if (v.question === null || v.round === null || !ON_AIR_PHASES.has(v.phase)) return null;
  return { roundIndex: v.round.index, questionIndex: v.question.index };
}

const firstOf = (rundown: Rundown, from: number): Target | null => {
  for (let r = Math.max(0, from); r < rundown.length; r++) {
    const q = rundown[r]?.questions[0];
    if (q !== undefined) return { roundIndex: r, questionIndex: q.index };
  }
  return null;
};

/**
 * The question that comes next in running order — what the host reads ahead. The engine's `nextQuestion`
 * wins when present; otherwise (before the game, at a round end) the first question of the next round.
 * Free-order rounds (board) have no "next": the operator picks a cell (null).
 */
export function nextTarget(v: Locatable): Target | null {
  if (v.phase === "game.end") return null;
  const next = v.nextQuestion;
  if (next !== null) {
    const order = v.round === null ? v.rundown : [v.rundown[v.round.index], ...v.rundown].filter((r) => r !== undefined);
    for (const r of order) {
      const q = r.questions.find((x) => x.id === next.id);
      if (q !== undefined) return { roundIndex: r.index, questionIndex: q.index };
    }
  }
  if (v.phase === "lobby" || v.round === null) return firstOf(v.rundown, 0);
  const round = v.rundown[v.round.index];
  if (round?.mechanic === "board" && v.phase !== "round.end") return null;
  // Last question of the round on screen or done: the next round starts with its first question.
  const qi = v.cursor?.questionIndex ?? v.question?.index ?? null;
  const inRound = round?.questions.find((q) => q.index === (qi === null ? 0 : qi + 1));
  if (inRound !== undefined && v.phase !== "round.end") return { roundIndex: v.round.index, questionIndex: inRound.index };
  return firstOf(v.rundown, v.round.index + 1);
}

export type AnswerItem = { readonly text: string; readonly right: boolean; readonly value: string | null };
/** An answer spec in words, for someone reading it out loud. */
export type AnswerDisplay = {
  /** The answer itself, in one line. */
  readonly headline: string;
  /** Options / items (right ones flagged), in display order; `ordered` = the order matters. */
  readonly items: readonly AnswerItem[];
  readonly ordered: boolean;
  /** Secondary info: synonyms, tolerance, stake… */
  readonly note: string | null;
};

const withUnit = (n: number, unit: string | undefined): string => (unit === undefined || unit === "" ? formatNumber(n) : `${formatNumber(n)} ${unit}`);

/** Where a normalised rectangle sits, in words (« en haut à gauche »). */
export function zoneWords(r: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): string {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const v = cy < 1 / 3 ? "en haut" : cy > 2 / 3 ? "en bas" : "au milieu";
  const h = cx < 1 / 3 ? "à gauche" : cx > 2 / 3 ? "à droite" : "au centre";
  return v === "au milieu" && h === "au centre" ? "au centre" : `${v} ${h}`;
}

export function formatAnswer(spec: AnswerSpec): AnswerDisplay {
  switch (spec.kind) {
    case "single": {
      const items = spec.options.map((o) => ({ text: o.label, right: o.id === spec.correct, value: null }));
      return { headline: items.find((i) => i.right)?.text ?? "—", items, ordered: false, note: null };
    }
    case "multi": {
      const items = spec.options.map((o) => ({ text: o.label, right: spec.correct.includes(o.id), value: null }));
      const n = items.filter((i) => i.right).length;
      return { headline: items.filter((i) => i.right).map((i) => i.text).join(" + "), items, ordered: false, note: n > 1 ? `${n} bonnes réponses` : null };
    }
    case "boolean":
      return { headline: spec.correct ? "Vrai" : "Faux", items: [], ordered: false, note: null };
    case "oral":
      return { headline: spec.expected, items: [], ordered: false, note: "Réponse à l'oral" };
    case "text": {
      const [first = "—", ...others] = spec.accepted;
      return { headline: first, items: [], ordered: false, note: others.length > 0 ? `Aussi accepté : ${others.join(", ")}` : null };
    }
    case "number": {
      const notes = [spec.tolerance > 0 ? `Tolérance ± ${withUnit(spec.tolerance, spec.unit)}` : null, spec.min !== undefined && spec.max !== undefined ? `Saisie entre ${formatNumber(spec.min)} et ${formatNumber(spec.max)}` : null].filter((x) => x !== null);
      return { headline: withUnit(spec.correct, spec.unit), items: [], ordered: false, note: notes.length > 0 ? notes.join(" · ") : null };
    }
    case "order":
      return { headline: `${spec.options[0]?.label ?? ""} → … → ${spec.options.at(-1)?.label ?? ""}`, items: spec.options.map((o) => ({ text: o.label, right: true, value: null })), ordered: true, note: null };
    case "pairs":
      return { headline: `${spec.pairs.length} associations`, items: spec.pairs.map((p) => ({ text: `${p.left} → ${p.right}`, right: true, value: null })), ordered: false, note: null };
    case "pin":
      return { headline: `Zone sur l'image, ${zoneWords(spec.target)}`, items: [], ordered: false, note: null };
    case "allocation": {
      const items = spec.options.map((o) => ({ text: o.label, right: o.id === spec.correct, value: null }));
      return { headline: items.find((i) => i.right)?.text ?? "—", items, ordered: false, note: `Mise de départ : ${formatNumber(spec.budget)}` };
    }
    case "poll": {
      const sorted = spec.options.toSorted((a, b) => (b.value ?? 0) - (a.value ?? 0));
      return {
        headline: sorted[0] === undefined ? "—" : `${sorted[0].label} en tête`,
        items: sorted.map((o) => ({ text: o.label, right: true, value: o.value === undefined ? null : formatNumber(o.value) })),
        ordered: true,
        note: `${sorted.length} réponses au tableau`,
      };
    }
    default:
      return { headline: "—", items: [], ordered: false, note: null };
  }
}
