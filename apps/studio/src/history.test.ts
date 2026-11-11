import { describe, expect, it } from "vitest";
import { createHistory } from "./history.ts";

describe("createHistory", () => {
  it("undoes and redoes step by step", () => {
    const h = createHistory<number>();
    h.record(0, undefined, 0);
    h.record(1, undefined, 10);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBe(0);
    expect(h.undo(0)).toBeNull();
    expect(h.redo(0)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.canRedo()).toBe(false);
  });
  it("merges edits with the same key in a short time (a drag = one step)", () => {
    const h = createHistory<number>(100, 1000);
    h.record(0, "drag", 0);
    h.record(1, "drag", 500);
    h.record(2, "drag", 900);
    expect(h.undo(3)).toBe(0);
    expect(h.canUndo()).toBe(false);
  });
  it("does not merge after the delay or across keys", () => {
    const h = createHistory<number>(100, 1000);
    h.record(0, "a", 0);
    h.record(1, "a", 2000);
    h.record(2, "b", 2100);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
  });
  it("a new edit drops the redo stack", () => {
    const h = createHistory<number>();
    h.record(0, undefined, 0);
    h.undo(1);
    h.record(0, undefined, 1);
    expect(h.canRedo()).toBe(false);
  });
  it("is bounded", () => {
    const h = createHistory<number>(3);
    for (let i = 0; i < 10; i++) h.record(i, undefined, i);
    expect([h.undo(10), h.undo(9), h.undo(8), h.undo(7)]).toEqual([9, 8, 7, null]);
  });
});
