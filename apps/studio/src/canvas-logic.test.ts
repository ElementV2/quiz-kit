import { describe, expect, it } from "vitest";
import { bandRect, fitScale, intersects, keepInside, moveRects, overflows, removeZones, resizeFrom, toggleRef } from "./canvas-logic.ts";

const S = { w: 1920, h: 1080 };

describe("canvas helpers (Scenes tab)", () => {
  it("flags and fixes zones outside the stage, without snapping", () => {
    expect(overflows({ x: 1800, y: 10, w: 300, h: 50 }, S)).toBe(true);
    expect(overflows({ x: 0, y: 0, w: 1920, h: 1080 }, S)).toBe(false);
    expect(keepInside({ x: 1801, y: -5, w: 300, h: 50 }, S)).toEqual({ x: 1620, y: 0, w: 300, h: 50 });
    expect(keepInside({ x: 3, y: 5, w: 3000, h: 50 }, S)).toEqual({ x: 0, y: 5, w: 1920, h: 50 });
  });
  it("moves a group by 1 px and stops it at the edge", () => {
    expect(moveRects([{ x: 10, y: 10, w: 10, h: 10 }], 1, 0, S)).toEqual([{ x: 11, y: 10, w: 10, h: 10 }]);
    const g = moveRects([{ x: 5, y: 0, w: 10, h: 10 }, { x: 100, y: 20, w: 10, h: 10 }], -10, -10, S);
    expect(g).toEqual([{ x: 0, y: 0, w: 10, h: 10 }, { x: 95, y: 20, w: 10, h: 10 }]);
  });
  it("resizes from any of the 8 handles", () => {
    const r = { x: 80, y: 80, w: 160, h: 160 };
    expect(resizeFrom(r, "se", 40, 40, S)).toEqual({ x: 80, y: 80, w: 200, h: 200 });
    expect(resizeFrom(r, "nw", -40, -40, S)).toEqual({ x: 40, y: 40, w: 200, h: 200 });
    expect(resizeFrom(r, "n", 0, -1000, S)).toEqual({ x: 80, y: 0, w: 160, h: 240 });
    expect(resizeFrom(r, "w", 1000, 0, S).w).toBe(16); // never inverted
    expect(resizeFrom(r, "e", 5000, 0, S)).toEqual({ x: 80, y: 80, w: 1840, h: 160 });
  });
  it("rubber band selection", () => {
    const b = bandRect({ x: 100, y: 100 }, { x: 10, y: 20 });
    expect(b).toEqual({ x: 10, y: 20, w: 90, h: 80 });
    expect(intersects(b, { x: 90, y: 90, w: 50, h: 50 })).toBe(true);
    expect(intersects(b, { x: 100, y: 0, w: 50, h: 50 })).toBe(false);
  });
  it("toggles a zone in the selection and removes several zones safely", () => {
    expect(toggleRef([{ layer: 0, zone: 1 }], { layer: 0, zone: 2 })).toEqual([{ layer: 0, zone: 1 }, { layer: 0, zone: 2 }]);
    expect(toggleRef([{ layer: 0, zone: 1 }], { layer: 0, zone: 1 })).toEqual([]);
    const layers = [{ zones: ["a", "b", "c"] }, { zones: ["d"] }];
    expect(removeZones(layers, [{ layer: 0, zone: 0 }, { layer: 0, zone: 2 }, { layer: 1, zone: 0 }])).toBe(3);
    expect(layers).toEqual([{ zones: ["b"] }, { zones: [] }]);
  });
  it("fits both width and height", () => {
    expect(fitScale({ w: 960, h: 1000 }, S)).toBe(0.5);
    expect(fitScale({ w: 2000, h: 540 }, S)).toBe(0.5);
  });
});
