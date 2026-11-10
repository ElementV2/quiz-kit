import { describe, expect, it } from "vitest";
import { pointsFor } from "./scoring.ts";

const j = (outcome: "correct" | "wrong", answeredAt: number) => ({ participantId: "p_1", outcome, answeredAt }) as const;
const w = { openedAt: 1000, durationMs: 10_000 };

describe("pointsFor", () => {
  it("gives base points for a correct answer", () => {
    expect(pointsFor([{ type: "base", points: 100 }], j("correct", 5000), w)).toBe(100);
  });

  it("decays linearly from base to minPoints over the window", () => {
    const rule = [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }] as const;
    expect(pointsFor([...rule], j("correct", 1000), w)).toBe(100);
    expect(pointsFor([...rule], j("correct", 6000), w)).toBe(75);
    expect(pointsFor([...rule], j("correct", 11_000), w)).toBe(50);
    expect(pointsFor([...rule], j("correct", 99_000), w)).toBe(50); // clamped
    expect(pointsFor([...rule], j("correct", 0), w)).toBe(100); // clamped
  });

  it("ignores timeDecay without timer", () => {
    expect(pointsFor([{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 0 }], j("correct", 9000), { openedAt: 0, durationMs: null })).toBe(100);
  });

  it("applies penalty to wrong answers only, and multipliers to both", () => {
    const rule = [{ type: "base", points: 10 }, { type: "penalty", points: -5 }, { type: "multiplier", factor: 2 }] as const;
    expect(pointsFor([...rule], j("correct", 0), w)).toBe(20);
    expect(pointsFor([...rule], j("wrong", 0), w)).toBe(-10);
  });

  it("gives 0 (not -0) to a wrong answer without penalty", () => {
    expect(Object.is(pointsFor([{ type: "base", points: 10 }], j("wrong", 0), w), 0)).toBe(true);
  });
});
