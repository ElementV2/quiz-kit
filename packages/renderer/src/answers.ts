import type { MechanicView } from "@quiz/schema";

/**
 * Human-readable answers (pure, unit-tested). An answer travels in its text form (`PlayerView.myAnswer`,
 * `ControlView.answers`): option ids, `[text]`, `[value]`, `["left:right"]`, `["x,y"]`, `["id:amount"]`.
 * These helpers only translate ids into labels: no verdict is computed here (the engine decides).
 */

/** French number formatting (thin spaces for thousands, comma for decimals). */
export function formatNumber(n: number): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 6 });
}

/** Normalised point of a pin answer (`["x,y"]`), null if malformed. */
export function parsePin(value: readonly string[] | null): { x: number; y: number } | null {
  const [x, y] = (value?.[0] ?? "").split(",").map(Number);
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Pairs of a pairs answer (`["left:right"]`). */
export function parsePairs(value: readonly string[] | null): { left: string; right: string }[] {
  return (value ?? []).flatMap((s) => {
    const i = s.indexOf(":");
    return i <= 0 ? [] : [{ left: s.slice(0, i), right: s.slice(i + 1) }];
  });
}

/** Amounts of an allocation answer (`["id:amount"]`). */
export function parseAllocation(value: readonly string[] | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of value ?? []) {
    const i = s.lastIndexOf(":");
    const n = Number(s.slice(i + 1));
    if (i > 0 && Number.isFinite(n)) out.set(s.slice(0, i), n);
  }
  return out;
}

const labelIn = (list: readonly { id: string; label: string }[] | null, id: string): string => list?.find((o) => o.id === id)?.label ?? id;
const unitOf = (unit: string | null): string => (unit === null || unit === "" ? "" : ` ${unit}`);

/** The right answer, as shown at reveal (or to the host / control earlier). Null if not known to this view. */
export function correctText(m: MechanicView | null): string | null {
  if (m === null) return null;
  switch (m.mechanic) {
    case "choice":
      if (m.kind === "vote") return m.correct === null || m.correct.length === 0 ? null : `En tête : ${m.correct.map((id) => labelIn(m.options, id)).join(" + ")}`;
      return m.correct === null ? null : m.correct.map((id) => labelIn(m.options, id)).join(" + ");
    case "ladder":
      return m.correct === null ? null : labelIn(m.options, m.correct);
    case "buzzer":
      return m.expected ?? (m.correct === null ? null : labelIn(m.options, m.correct));
    case "text-answer":
    case "board":
      return m.correct;
    case "number-answer": {
      if (m.correct === null) return null;
      const tol = m.mode === "tolerance" && m.tolerance !== null && m.tolerance > 0 ? ` (± ${formatNumber(m.tolerance)})` : "";
      return `${formatNumber(m.correct)}${unitOf(m.unit)}${tol}`;
    }
    case "order":
      return m.correct === null ? null : m.correct.map((id) => labelIn(m.options, id)).join(" → ");
    case "pairs":
      return m.correct === null ? null : m.correct.map((c) => `${labelIn(m.left, c.left)} — ${labelIn(m.right, c.right)}`).join(" · ");
    case "pin":
      return m.correct === null ? null : "Zone indiquée sur l'image";
    case "allocation":
      return m.correct === null ? null : labelIn(m.options, m.correct);
    case "crowd-vote":
      if (m.correct !== null) return labelIn(m.options, m.correct);
      return m.majority === null || m.majority.length === 0 ? null : `Le chat a choisi : ${m.majority.map((id) => labelIn(m.options, id)).join(" / ")}`;
    case "hints":
    case "reveal-image":
      if (m.correct === null) return null;
      return m.input === "choice" ? labelIn(m.options, m.correct) : m.correct;
    case "poll-board":
      return null;
    case "chain":
      return m.expected;
    default:
      return null;
  }
}

/** A player's answer (text form) in words, e.g. for the tablet recap or the control room's answer list. */
export function answerText(m: MechanicView | null, value: readonly string[] | null): string {
  if (m === null || value === null || value.length === 0) return "";
  switch (m.mechanic) {
    case "choice":
    case "ladder":
    case "buzzer":
    case "board":
      return value.map((id) => labelIn(optionList(m), id)).join(" + ");
    case "hints":
    case "reveal-image":
      return m.input === "text" ? (value[0] ?? "") : value.map((id) => labelIn(m.options, id)).join(" + ");
    case "allocation":
      return allocationText(m, value);
    case "text-answer":
      return value[0] ?? "";
    case "number-answer": {
      const n = Number(value[0]);
      return Number.isFinite(n) ? `${formatNumber(n)}${unitOf(m.unit)}` : (value[0] ?? "");
    }
    case "order":
      return value.map((id) => labelIn(m.options, id)).join(" → ");
    case "pairs":
      return parsePairs(value).map((x) => `${labelIn(m.left, x.left)} — ${labelIn(m.right, x.right)}`).join(" · ");
    case "pin": {
      const pt = parsePin(value);
      return pt === null ? "" : `point (${Math.round(pt.x * 100)} %, ${Math.round(pt.y * 100)} %)`;
    }
    case "poll-board":
    case "crowd-vote":
    case "chain":
      return value.join(", ");
    default:
      return value.join(", ");
  }
}

function optionList(m: MechanicView): readonly { id: string; label: string }[] | null {
  switch (m.mechanic) {
    case "choice":
    case "ladder":
    case "order":
    case "allocation":
    case "crowd-vote":
    case "buzzer":
    case "board":
    case "hints":
    case "reveal-image":
      return m.options;
    case "poll-board":
    case "text-answer":
    case "number-answer":
    case "pairs":
    case "pin":
    case "chain":
      return null;
    default:
      return null;
  }
}

/** Allocation answers: "La Loire : 6 000 · La Seine : 4 000" (non-zero amounts only). */
export function allocationText(m: MechanicView | null, value: readonly string[] | null): string {
  if (m?.mechanic !== "allocation") return "";
  return [...parseAllocation(value)].filter(([, n]) => n > 0).map(([id, n]) => `${labelIn(m.options, id)} : ${formatNumber(n)}`).join(" · ");
}

/** Board grid as rows (index 0 = first value row) × categories, for a table layout. */
export function boardRows(m: Extract<MechanicView, { mechanic: "board" }>): ({ questionIndex: number; value: number; played: boolean } | null)[][] {
  const depth = Math.max(0, ...m.categories.map((c) => c.cells.length));
  return Array.from({ length: depth }, (_, row) => m.categories.map((c) => c.cells[row] ?? null));
}
