import { describe, expect, it } from "vitest";
import type { MechanicView } from "@quiz/schema";
import { allocationText, answerText, boardRows, correctText, parseAllocation, parsePairs, parsePin } from "./answers.ts";
import { optionShare } from "./logic.ts";

const opts = [{ id: "a", label: "Rhône" }, { id: "b", label: "Loire" }, { id: "c", label: "Seine" }];

const order: MechanicView = { mechanic: "order", options: opts, correct: ["b", "a", "c"], answeredCount: 3 };
const pairs: MechanicView = { mechanic: "pairs", left: [{ id: "p1", label: "Japon" }, { id: "p2", label: "Canada" }], right: [{ id: "r0", label: "Ottawa" }, { id: "r1", label: "Tokyo" }], correct: [{ left: "p1", right: "r1" }, { left: "p2", right: "r0" }], answeredCount: 1 };
const number: MechanicView = { mechanic: "number-answer", mode: "tolerance", unit: "m", min: 0, max: 2000, correct: 330, tolerance: 10, answeredCount: 2, ranking: null };
const alloc: MechanicView = { mechanic: "allocation", options: opts, budget: 10_000, keepOneEmpty: true, correct: "b", counts: { a: 2000, b: 6000, c: 2000 }, answeredCount: 1 };
const hintsChoice: MechanicView = { mechanic: "hints", hints: ["h1"], hintCount: 1, total: 3, points: 100, input: "choice", options: opts, correct: "c", answeredCount: 0 };

describe("answer text forms", () => {
  it("parses pin, pairs and allocation forms, ignoring malformed parts", () => {
    expect(parsePin(["0.25,0.5"])).toEqual({ x: 0.25, y: 0.5 });
    expect(parsePin(["x"])).toBeNull();
    expect(parsePin(null)).toBeNull();
    expect(parsePairs(["p1:r1", "bad", "p2:r0"])).toEqual([{ left: "p1", right: "r1" }, { left: "p2", right: "r0" }]);
    expect([...parseAllocation(["a:2000", "b:8000", "c:x"])]).toEqual([["a", 2000], ["b", 8000]]);
  });

  it("puts labels on every answer form", () => {
    expect(answerText(order, ["a", "b", "c"])).toBe("Rhône → Loire → Seine");
    expect(answerText(pairs, ["p1:r1", "p2:r0"])).toBe("Japon — Tokyo · Canada — Ottawa");
    expect(answerText(number, ["1234.5"])).toMatch(/^1\s?234,5 m$/);
    expect(answerText({ mechanic: "pin", image: null, correct: null, answeredCount: null, pins: null }, ["0.1,0.9"])).toBe("point (10 %, 90 %)");
    expect(allocationText(alloc, ["a:0", "b:10000"])).toMatch(/^Loire : 10\s?000$/);
    expect(answerText(hintsChoice, ["c"])).toBe("Seine");
    expect(answerText({ mechanic: "text-answer", correct: null, answeredCount: null, review: null }, ["Canberra"])).toBe("Canberra");
    expect(answerText(order, null)).toBe("");
  });

  it("writes the right answer only when the view carries it", () => {
    expect(correctText(order)).toBe("Loire → Rhône → Seine");
    expect(correctText(pairs)).toBe("Japon — Tokyo · Canada — Ottawa");
    expect(correctText(number)).toBe("330 m (± 10)");
    expect(correctText({ ...number, mode: "closest", correct: 206, unit: null, tolerance: 0 })).toBe("206");
    expect(correctText(alloc)).toBe("Loire");
    expect(correctText(hintsChoice)).toBe("Seine");
    expect(correctText({ ...hintsChoice, input: "text", options: null, correct: "Marie Curie" })).toBe("Marie Curie");
    expect(correctText({ ...order, correct: null })).toBeNull();
    expect(correctText(null)).toBeNull();
  });

  it("shares allocation amounts like answer counts", () => {
    expect(optionShare(alloc, "b")).toBeCloseTo(0.6);
    expect(optionShare({ ...alloc, counts: null }, "b")).toBeNull();
  });

  it("lays the board out as value rows × categories, short columns padded", () => {
    const rows = boardRows({
      mechanic: "board",
      categories: [
        { name: "Sciences", cells: [{ questionIndex: 0, value: 200, played: true }, { questionIndex: 1, value: 400, played: false }] },
        { name: "Lettres", cells: [{ questionIndex: 2, value: 200, played: false }] },
      ],
      cell: null, kind: "oral", options: null, correct: null, hand: null, winner: null, queue: null, lockedOut: null, me: null,
    });
    expect(rows.map((r) => r.map((c) => c?.value ?? null))).toEqual([[200, 200], [400, null]]);
  });
});
