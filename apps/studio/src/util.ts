import { unwrap } from "solid-js/store";
import type { GameDocument } from "@quiz/schema";

/** Random hex id body (studio-side ids: questions, rounds, zones). */
export const hex = (n: number): string => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

/** Untracked deep copy (for writes: reconcile, structuredClone of presets). */
export const clone = <T,>(v: T): T => structuredClone(unwrap(v));

/**
 * TRACKED deep copy: reads every property through the store proxy, so memos depending on it re-run on any edit.
 * (`unwrap` bypasses tracking: a memo built on it would keep validating — and saving — the first version.)
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON round-trip of a JSON document keeps its type
export const snapshot = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Mutating edit of the game document (one undo step, see history.ts). `key` merges quick repeated edits. */
export type Update = (f: (d: GameDocument) => void, key?: string) => void;

/** True when a keyboard event is typed into a field (shortcuts must not fire there). */
export function inField(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}
