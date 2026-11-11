import { describe, expect, it } from "vitest";
import { allocAdjust, allocAllIn, allocProblem, allocRemaining, allocStep, initialOrder, keypadPress, linkPair, linksFrom, moveItem, normPoint, numberProblem, pairsComplete, parseDecimal, unlinkRight } from "./inputs-logic.ts";

describe("order input", () => {
  it("moves items up and down, ignores moves past the ends", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("starts from the saved answer only when it is a full ordering", () => {
    expect(initialOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(initialOrder(["a", "b", "c"], ["c", "a"])).toEqual(["a", "b", "c"]);
    expect(initialOrder(["a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("pairs input", () => {
  it("keeps one right item per left item and the other way round", () => {
    let l = linkPair({}, "p1", "r0");
    l = linkPair(l, "p2", "r0"); // r0 moves to p2
    expect(l).toEqual({ p2: "r0" });
    l = linkPair(l, "p2", "r1"); // p2 changes its mind
    expect(l).toEqual({ p2: "r1" });
    l = linkPair(l, "p1", "r0");
    expect(pairsComplete(l, ["p1", "p2"])).toBe(true);
    expect(unlinkRight(l, "r0")).toEqual({ p2: "r1" });
    expect(pairsComplete(unlinkRight(l, "r0"), ["p1", "p2"])).toBe(false);
    expect(linksFrom(["p1:r0", "p2:r1", "bad"])).toEqual({ p1: "r0", p2: "r1" });
  });
});

describe("allocation input", () => {
  it("steps by a round tenth of the budget", () => {
    expect(allocStep(10_000)).toBe(1000);
    expect(allocStep(1000)).toBe(100);
    expect(allocStep(250)).toBe(20);
    expect(allocStep(5)).toBe(1);
  });

  it("never goes below 0 nor above the budget", () => {
    let a = allocAdjust({}, "a", 7000, 10_000);
    a = allocAdjust(a, "b", 5000, 10_000); // only 3000 left
    expect(a).toEqual({ a: 7000, b: 3000 });
    expect(allocRemaining(a, 10_000)).toBe(0);
    expect(allocAdjust(a, "a", -9000, 10_000)).toEqual({ a: 0, b: 3000 });
    expect(allocAllIn({ a: 2000 }, "c", 10_000)).toEqual({ a: 2000, c: 8000 });
  });

  it("is ready only when the whole budget is placed and one option stays empty", () => {
    expect(allocProblem({ a: 5000 }, ["a", "b", "c"], 10_000)).toMatch(/^Encore 5\s?000 à placer$/);
    expect(allocProblem({ a: 5000, b: 3000, c: 2000 }, ["a", "b", "c"], 10_000)).toBe("Laissez au moins une proposition vide");
    expect(allocProblem({ a: 5000, b: 3000, c: 2000 }, ["a", "b", "c"], 10_000, false)).toBeNull();
    expect(allocProblem({ a: 6000, b: 4000 }, ["a", "b", "c"], 10_000)).toBeNull();
  });
});

const type = (keys: string[]): string => keys.reduce(keypadPress, "");

describe("number input", () => {
  it("types with the keypad: one comma, sign toggle, backspace, no leading zeros", () => {
    expect(type(["0", "2", "0", "6"])).toBe("206");
    expect(type([",", "5", ","])).toBe("0,5");
    expect(type(["3", "−", "4"])).toBe("-34");
    expect(type(["3", "3", "⌫"])).toBe("3");
    expect(type(["−", "0", "7"])).toBe("-7");
  });

  it("parses French and dotted decimals, checks the range", () => {
    expect(parseDecimal("1 234,5")).toBe(1234.5);
    expect(parseDecimal("-3.25")).toBe(-3.25);
    expect(parseDecimal("0,")).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(numberProblem(null, 0, 10)).toBe("Saisissez un nombre");
    expect(numberProblem(-1, 0, 10)).toBe("Au moins 0");
    expect(numberProblem(11, 0, 10)).toBe("Au plus 10");
    expect(numberProblem(5, null, null)).toBeNull();
  });
});

describe("pin input", () => {
  it("normalises the tap on the picture and clamps it", () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(normPoint(200, 100, rect)).toEqual({ x: 0.25, y: 0.25 });
    expect(normPoint(0, 400, rect)).toEqual({ x: 0, y: 1 });
    expect(normPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});
