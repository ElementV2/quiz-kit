import { describe, expect, it } from "vitest";
import { NormRect } from "@quiz/schema";
import { freeOptionId, normRectFromDrag, splitList } from "./question-factories.ts";

describe("question editor helpers", () => {
  it("finds a free option id", () => {
    expect(freeOptionId(["a", "b", "d"])).toBe("c");
    expect(freeOptionId("abcdefghijklmnopqrstuvwxyz".split(""))).toBe("o27");
  });
  it("pin target from a drag, in any direction, clamped to the image", () => {
    expect(normRectFromDrag({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: 0.1, w: 0.4, h: 0.4 });
    const r = normRectFromDrag({ x: 0.9, y: 0.9 }, { x: 1.4, y: 1.3 });
    expect(r).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
    expect(NormRect.safeParse(normRectFromDrag({ x: 1, y: 1 }, { x: 1, y: 1 })).success).toBe(true); // a click: tiny but valid
  });
  it("splits hints and tags", () => {
    expect(splitList(" un \n\n deux \n", /\n/)).toEqual(["un", "deux"]);
    expect(splitList("géo, , capitales", /,/)).toEqual(["géo", "capitales"]);
  });
});
