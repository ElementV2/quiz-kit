/**
 * Bounded undo / redo of the whole game document (studio only, doc 07 « undo/redo »).
 * `record(before)` is called before each edit; edits sharing a `key` within `mergeMs` form ONE step
 * (a drag, a series of arrow nudges, typing in one field).
 */
export type History<T> = {
  record(before: T, key: string | undefined, now: number): void;
  undo(current: T): T | null;
  redo(current: T): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
};

export function createHistory<T>(limit = 100, mergeMs = 1500): History<T> {
  let past: T[] = [];
  let future: T[] = [];
  let last: { key: string; at: number } | null = null;
  return {
    record(before, key, now) {
      future = [];
      if (key !== undefined && last !== null && last.key === key && now - last.at <= mergeMs) {
        last = { key, at: now };
        return;
      }
      past.push(before);
      if (past.length > limit) past = past.slice(past.length - limit);
      last = key === undefined ? null : { key, at: now };
    },
    undo(current) {
      const prev = past.pop();
      if (prev === undefined) return null;
      future.push(current);
      last = null;
      return prev;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(current);
      last = null;
      return next;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = [];
      future = [];
      last = null;
    },
  };
}
