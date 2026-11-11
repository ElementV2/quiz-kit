import { describe, expect, it } from "vitest";
import { DEMO_GAME, PROGRAM_SCENE, View } from "@quiz/schema";
import { assetSheet, assetSheetCsv, clampRect, deriveStates, matchDeliveredAssets, outsideSafe, simulateView, templateSvg } from "./studio-logic.ts";

describe("simulateView (engine run locally)", () => {
  it.each(["idle", "presenting", "open", "locked", "revealed", "game.end"] as const)("reaches %s with a valid output view", (phase) => {
    const v = simulateView(DEMO_GAME, phase);
    expect(v?.phase).toBe(phase);
    expect(View.safeParse(v).success).toBe(true);
  });
  it("shows answers and the correct one only once revealed", () => {
    const open = simulateView(DEMO_GAME, "open");
    const revealed = simulateView(DEMO_GAME, "revealed");
    expect(open?.mechanic).toMatchObject({ correct: null, answeredCount: 3 });
    expect(revealed?.mechanic).toMatchObject({ correct: ["b"], counts: { a: 2, b: 1 } });
    expect(revealed?.leaderboard).toHaveLength(3);
  });
});

describe("canvas helpers", () => {
  it("snaps and clamps rectangles inside the scene", () => {
    expect(clampRect({ x: -13, y: 5, w: 3, h: 2001 }, { w: 1920, h: 1080 })).toEqual({ x: 0, y: 0, w: 16, h: 1080 });
    expect(clampRect({ x: 1915, y: 1077, w: 100, h: 100 }, { w: 1920, h: 1080 })).toEqual({ x: 1816, y: 976, w: 104, h: 104 });
  });
  it("flags zones outside the EBU graphics safe area", () => {
    const z = PROGRAM_SCENE.layers[0]?.zones[0];
    if (z === undefined) throw new Error("fixture");
    expect(outsideSafe(z)).toBe(false);
    expect(outsideSafe({ ...z, rect: { x: 10, y: 10, w: 100, h: 100 } })).toBe(true);
  });
});

describe("designer template", () => {
  it("one asset per state for a repeated zone (not one per cell), 2x sizes", () => {
    const answers = assetSheet(PROGRAM_SCENE).filter((a) => a.zone === "answers");
    expect(answers.map((a) => a.state)).toEqual(["idle", "selected", "correct", "wrong"]);
    expect(answers[0]).toMatchObject({ file: "answers_idle@2x.png", w: 854, h: 120, w2: 1708, h2: 240 });
    expect(assetSheetCsv(PROGRAM_SCENE).split("\n")[0]).toBe("fichier;zone;état;x;y;taille 1x;taille 2x;notes");
  });
  it("SVG places zones, safe areas and the longest text, escaped", () => {
    const svg = templateSvg(PROGRAM_SCENE, { ...DEMO_GAME, questions: [{ ...(DEMO_GAME.questions[0] ?? DEMO_GAME.questions[1]!), prompt: { text: "A <b>long</b> & \"tricky\" question?" } }] }); // oxlint-disable-line typescript/no-non-null-assertion -- fixture has 3 questions
    expect(svg).toContain('<g id="answers"');
    expect(svg).toContain("A &lt;b&gt;long&lt;/b&gt; &amp; &quot;tricky&quot; question?");
    expect(svg).toContain("EBU R 95");
  });
  it("re-import by naming: matched, wrong sizes, missing, unknown", () => {
    const r = matchDeliveredAssets(PROGRAM_SCENE, [
      { name: "answers_idle@2x.png", w: 1708, h: 240 },
      { name: "answers_correct@2x.png", w: 800, h: 240 },
      { name: "logo.png", w: 10, h: 10 },
    ]);
    expect(r.matched.map((m) => m.file)).toEqual(["answers_idle@2x.png"]);
    expect(r.wrongSize).toEqual(["answers_correct@2x.png : 800×240 au lieu de 1708×240"]);
    expect(r.unknown).toEqual(["logo.png"]);
    expect(r.missing).toContain("answers_wrong@2x.png");
  });
  it("derives missing states from the idle look without overwriting designed ones", () => {
    const z = PROGRAM_SCENE.layers[0]?.zones[2];
    if (z === undefined) throw new Error("fixture");
    const states = deriveStates({ ...z, states: { idle: { background: "red" }, correct: { background: "green" } } });
    expect(states["wrong"]).toMatchObject({ background: "red", filter: expect.stringContaining("grayscale") });
    expect(states["correct"]).toMatchObject({ background: "green" });
  });
});
