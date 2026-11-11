/**
 * Pure helpers of the tablet inputs (unit-tested). They only shape a draft answer before it is sent:
 * the server validates and judges it (no game rule here).
 */

/** Moves one item up (delta −1) or down (+1); out-of-range moves leave the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, delta: number): T[] {
  const to = from + delta;
  const out = [...list];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return out;
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}

/** Starting order: the player's saved answer if it is a full ordering of the options, else the shown order. */
export function initialOrder(optionIds: readonly string[], mine: readonly string[] | null): string[] {
  if (mine !== null && mine.length === optionIds.length && optionIds.every((id) => mine.includes(id))) return [...mine];
  return [...optionIds];
}

/** Links a left item to a right one (left → right). A right item belongs to one left item only. */
export function linkPair(links: Readonly<Record<string, string>>, left: string, right: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [l, r] of Object.entries(links)) if (r !== right && l !== left) out[l] = r;
  out[left] = right;
  return out;
}

/** Removes the link that uses this right item. */
export function unlinkRight(links: Readonly<Record<string, string>>, right: string): Record<string, string> {
  return Object.fromEntries(Object.entries(links).filter(([, r]) => r !== right));
}

export const pairsComplete = (links: Readonly<Record<string, string>>, leftIds: readonly string[]): boolean => leftIds.every((id) => links[id] !== undefined);

/** Saved pairs answer (`["left:right"]`) → links. */
export function linksFrom(mine: readonly string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of mine ?? []) {
    const i = s.indexOf(":");
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** +/− step for a budget: a tenth, rounded down to 1 / 2 / 5 × 10ⁿ (10 000 → 1 000). */
export function allocStep(budget: number): number {
  const raw = budget / 10;
  if (raw < 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

export const allocTotal = (amounts: Readonly<Record<string, number>>): number => Object.values(amounts).reduce((a, b) => a + b, 0);
export const allocRemaining = (amounts: Readonly<Record<string, number>>, budget: number): number => budget - allocTotal(amounts);

/** Adds `delta` to one option, never below 0 nor above what remains. */
export function allocAdjust(amounts: Readonly<Record<string, number>>, id: string, delta: number, budget: number): Record<string, number> {
  const cur = amounts[id] ?? 0;
  const next = Math.max(0, Math.min(cur + delta, cur + allocRemaining(amounts, budget)));
  return { ...amounts, [id]: next };
}

/** Puts everything that remains on one option. */
export function allocAllIn(amounts: Readonly<Record<string, number>>, id: string, budget: number): Record<string, number> {
  return { ...amounts, [id]: (amounts[id] ?? 0) + Math.max(0, allocRemaining(amounts, budget)) };
}

/**
 * Can the allocation be sent? The whole budget must be placed and (default rule of the mechanic) at least
 * one option left empty. Returns the reason shown under the button, null when ready.
 */
export function allocProblem(amounts: Readonly<Record<string, number>>, optionIds: readonly string[], budget: number, keepOneEmpty = true): string | null {
  const left = allocRemaining(amounts, budget);
  if (left > 0) return `Encore ${left.toLocaleString("fr-FR")} à placer`;
  if (left < 0) return "Trop placé";
  if (keepOneEmpty && optionIds.length > 1 && optionIds.every((id) => (amounts[id] ?? 0) > 0)) return "Laissez au moins une proposition vide";
  return null;
}

/** On-screen keypad (cheap tablets: no system keyboard over the question). Keys: 0-9 , − ⌫. */
export function keypadPress(cur: string, key: string): string {
  if (key === "⌫") return cur.slice(0, -1);
  if (key === "−") return cur.startsWith("-") ? cur.slice(1) : `-${cur}`;
  if (cur.replace("-", "").length >= 15) return cur;
  if (key === ",") return cur.includes(",") ? cur : `${cur === "" || cur === "-" ? `${cur}0` : cur},`;
  if (/^\d$/.test(key)) return cur === "0" ? key : cur === "-0" ? `-${key}` : cur + key;
  return cur;
}

/** "1 234,5" / "1234.5" → 1234.5; null if not a number. */
export function parseDecimal(text: string): number | null {
  const t = text.replaceAll(/[\s  ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Out-of-range message for the numeric input, null when the value can be sent. */
export function numberProblem(value: number | null, min: number | null, max: number | null): string | null {
  if (value === null) return "Saisissez un nombre";
  if (min !== null && value < min) return `Au moins ${min.toLocaleString("fr-FR")}`;
  if (max !== null && value > max) return `Au plus ${max.toLocaleString("fr-FR")}`;
  return null;
}

const clamp01 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;

/** Tap position on the image → normalised point (0..1, 4 decimals), clamped to the picture. */
export function normPoint(clientX: number, clientY: number, rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
}
