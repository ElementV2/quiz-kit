import { describe, expect, it } from "vitest";
import { View } from "@quiz/schema";
import { PARTICLES, detectMoments, parseEffectsLevel } from "./moments.ts";

const base = (over: Record<string, unknown> = {}) =>
  View.parse({
    role: "output",
    sessionId: "ses_1",
    phase: "locked",
    round: null,
    question: { id: "q_1", index: 0, count: 3, prompt: { text: "Q" } },
    timer: null,
    mechanic: { mechanic: "choice", kind: "single", options: [{ id: "a", label: "A" }], minPick: 1, maxPick: 1, correct: null, counts: null, answeredCount: 1 },
    leaderboard: [{ participantId: "p_1", displayName: "Ana", teamId: null, total: 10, rank: 1 }],
    ...over,
  });

describe("detectMoments", () => {
  it("fires answer.correct once when the answer is revealed, never on a reload snapshot", () => {
    const revealed = base({ phase: "revealed", mechanic: { mechanic: "choice", kind: "single", options: [{ id: "a", label: "A" }], minPick: 1, maxPick: 1, correct: ["a"], counts: { a: 1 }, answeredCount: 1 } });
    expect(detectMoments(base(), revealed, 0)).toEqual([{ kind: "answer.correct" }]);
    expect(detectMoments(revealed, revealed, 0)).toEqual([]);
    expect(detectMoments(null, revealed, 0)).toEqual([]);
  });

  it("detects a new leader and the podium", () => {
    const next = base({ phase: "game.end", question: null, mechanic: null, leaderboard: [{ participantId: "p_2", displayName: "Bo", teamId: null, total: 20, rank: 1 }] });
    expect(detectMoments(base(), next, 0)).toEqual([{ kind: "leader.changed", leader: "Bo" }, { kind: "podium" }]);
  });

  it("detects the last 5 seconds of a running timer", () => {
    const t = base({ phase: "open", timer: { endsAt: 10_000, durationMs: 20_000 } });
    expect(detectMoments(t, t, 5_500)).toEqual([{ kind: "timer.last5" }]);
    expect(detectMoments(t, t, 2_000)).toEqual([]);
  });

  it("quality levels: default light, off means no particle", () => {
    expect(parseEffectsLevel(null)).toBe("light");
    expect(parseEffectsLevel("full")).toBe("full");
    expect(parseEffectsLevel("nope")).toBe("light");
    expect(PARTICLES.off).toBe(0);
  });
});
