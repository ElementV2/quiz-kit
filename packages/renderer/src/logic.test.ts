import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, Layer, type MechanicView } from "@quiz/schema";
import { MATERIALS, estimateFontSize, layerVisible, optionShare, optionState, readPath, secondsLeft, themeVars } from "./logic.ts";

const choice = (over: Partial<Extract<MechanicView, { mechanic: "choice" }>> = {}): MechanicView => ({
  mechanic: "choice",
  kind: "single",
  options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  minPick: 1,
  maxPick: 1,
  correct: null,
  counts: null,
  answeredCount: 0,
  ...over,
});

describe("readPath", () => {
  it("walks objects and arrays, never prototypes", () => {
    const v = { question: { prompt: { text: "Q" } }, leaderboard: [{ total: 5 }] };
    expect(readPath(v, "question.prompt.text")).toBe("Q");
    expect(readPath(v, "leaderboard.0.total")).toBe(5);
    expect(readPath(v, "question.nope.x")).toBeUndefined();
    expect(readPath(v, "constructor")).toBeUndefined();
    expect(readPath(v, "leaderboard.x")).toBeUndefined();
  });
});

describe("layerVisible", () => {
  const auto = Layer.parse({ id: "l", name: "L", z: 1, phases: ["open"], zones: [] });
  const manual = Layer.parse({ id: "m", name: "M", z: 1, mode: "manual", zones: [] });
  const hold = Layer.parse({ id: "h", name: "H", z: 1, mode: "auto-hold", phases: ["revealed"], zones: [] });
  it("auto follows phases, manual follows TAKE, auto-hold needs both", () => {
    expect([layerVisible(auto, "open", {}), layerVisible(auto, "idle", {})]).toEqual([true, false]);
    expect([layerVisible(manual, "open", {}), layerVisible(manual, "open", { m: true })]).toEqual([false, true]);
    expect([layerVisible(hold, "revealed", {}), layerVisible(hold, "revealed", { h: true }), layerVisible(hold, "open", { h: true })]).toEqual([false, true, false]);
  });
});

describe("option states", () => {
  it("idle → selected (player) → correct / wrong only once revealed", () => {
    expect(optionState(choice(), "a", null)).toBe("idle");
    expect(optionState(choice(), "a", ["a"])).toBe("selected");
    const revealed = choice({ correct: ["b"], counts: { a: 3, b: 1 } });
    expect([optionState(revealed, "a", ["a"]), optionState(revealed, "b", null)]).toEqual(["wrong", "correct"]);
    expect(optionShare(revealed, "a")).toBe(0.75);
    expect(optionShare(choice(), "a")).toBeNull();
  });
  it("host view (correct known, no counts yet) does not show correct/wrong styling early", () => {
    expect(optionState(choice({ correct: ["b"] }), "b", null)).toBe("idle");
  });
});

describe("misc", () => {
  it("countdown never negative", () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
  });
  it("theme → CSS variables", () => {
    expect(themeVars(DEFAULT_THEME)).toMatchObject({ "--q-color-primary": "#e9b13b", "--q-color-surface-alt": "#1d1f25", "--q-radius": "4px", "--q-logo": "none", "--q-mat-image": "none" });
    const neon = themeVars({ ...DEFAULT_THEME, material: "neon", logo: "a".repeat(64) }, (h) => `blob:${h.slice(0, 2)}`);
    expect(neon["--q-logo"]).toBe("url(blob:aa)");
    expect(neon["--q-mat-border"]).toContain("var(--q-color-accent)");
    // Every material defines every variable (no stale value from another material).
    for (const m of Object.values(MATERIALS)) expect(Object.keys(m).toSorted()).toEqual(Object.keys(MATERIALS.flat).toSorted());
  });
  it("estimates a smaller font for longer text", () => {
    const box = { w: 1000, h: 200 };
    expect(estimateFontSize("court", box, 80)).toBeGreaterThan(estimateFontSize("un texte beaucoup plus long ".repeat(8), box, 80));
  });
});
