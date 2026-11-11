import { describe, expect, it } from "vitest";
import { MixedKinds, defaultRegistry } from "@quiz/engine";
import { DEMO_EVENING_GAME, DEMO_GAME, DEMO_POLL_GAME, GameDocument, PER_KIND_MECHANICS, TEMPLATES, type Question } from "@quiz/schema";
import { MECHANICS, MIXED_CATEGORIES, normalizeRule, mixedCategoryCounts, mixedCategoryValues, mixedScoring, setMixedField, setMixedScoring, addToRound, configValues, defaultConfig, deleteQuestion, deleteRound, duplicateRound, mechanicOptions, moveItem, newRound, newScoring, parseNumberList, removeFromRound, roundIssues, roundsOf, setConfigField, setMechanic, swapList } from "./format-logic.ts";
import { QUESTION_TYPES, newQuestion } from "./question-factories.ts";

/** Keys of a mechanic config schema (zod object shape). */
const configKeys = (id: string): string[] => {
  const schema = defaultRegistry.get(id)?.configSchema;
  return schema !== undefined && "shape" in schema && typeof schema.shape === "object" && schema.shape !== null ? Object.keys(schema.shape).toSorted() : [];
};

const copy = (g: GameDocument): GameDocument => structuredClone(g);

describe("mechanic catalogue", () => {
  it("labels every offered round type in French: « Mixte » first, then the round-level formats", () => {
    expect(defaultRegistry.ids().filter((id) => !PER_KIND_MECHANICS.has(id) && MECHANICS[id] === undefined)).toEqual([]);
    // « Mixte » + the round-level formats only: one-kind types are played inside « Mixte », never offered.
    expect(mechanicOptions(defaultRegistry).map((m) => m.id)[0]).toBe("mixed");
    expect(mechanicOptions(defaultRegistry).map((m) => m.id).toSorted()).toEqual([...defaultRegistry.ids()].filter((id) => !PER_KIND_MECHANICS.has(id)).toSorted());
  });
  it("form fields match the keys of each mechanic config schema", () => {
    const ids = Object.keys(MECHANICS).filter((id) => id !== "mixed"); // mixed: one form per category (below)
    expect(ids.map((id) => [id, MECHANICS[id]?.fields.map((f) => f.key).toSorted()])).toEqual(ids.map((id) => [id, configKeys(id)]));
    // Each category block offers every setting of its schema (its points rule apart).
    const shape = MixedKinds.shape;
    expect(MIXED_CATEGORIES.map((c) => [c.id, c.fields.map((f) => f.key).toSorted()])).toEqual(
      MIXED_CATEGORIES.map((c) => [c.id, Object.keys(shape[c.id].unwrap().shape).filter((k) => k !== "scoring").toSorted()]),
    );
  });
  it("default configs are valid for every mechanic (ladder included)", () => {
    expect(defaultRegistry.ids().filter((id) => defaultRegistry.get(id)?.configSchema.safeParse(defaultConfig(defaultRegistry, id)).success !== true)).toEqual([]);
    expect(defaultConfig(defaultRegistry, "board")).toMatchObject({ values: [100, 200, 300, 400, 500], penalty: true });
  });
  it("a new mixed round scores surveys per answer (each team what it finds)", () => {
    expect(mixedCategoryValues(defaultRegistry, { mechanic: "mixed", mechanicConfig: defaultConfig(defaultRegistry, "mixed") }, "poll")).toMatchObject({ mode: "per-answer" });
  });
  it("mixed settings by category: own value over the older flat key; own points rule or the round's", () => {
    const g = copy(DEMO_GAME);
    setMechanic(g, 0, "mixed", defaultRegistry);
    const r = () => g.format.rounds[0] ?? newRound(defaultRegistry, "x", 1);
    setConfigField(g, 0, "allowChange", false); // older flat key
    expect(mixedCategoryValues(defaultRegistry, r(), "text")).toMatchObject({ allowChange: false });
    setMixedField(g, 0, "text", "allowChange", true);
    expect(mixedCategoryValues(defaultRegistry, r(), "text")).toMatchObject({ allowChange: true });
    expect(mixedCategoryValues(defaultRegistry, r(), "choice")).toMatchObject({ allowChange: false });
    setMixedScoring(g, 0, "text", [{ type: "base", points: 500 }]);
    expect(mixedScoring(r(), "text")).toEqual([{ type: "base", points: 500 }]);
    expect(GameDocument.safeParse(g).success && defaultRegistry.get("mixed")?.configSchema.safeParse(r().mechanicConfig).success).toBe(true);
    setMixedScoring(g, 0, "text", null);
    expect(mixedScoring(r(), "text")).toBeNull();
    expect(mixedCategoryCounts(g, r()).get("choice")).toBe(3);
  });
  it("a points rule stays valid while edited (decay minimum never above the base)", () => {
    expect(normalizeRule([{ type: "base", points: 300 }, { type: "timeDecay", minPoints: 500 }])).toEqual([{ type: "base", points: 300 }, { type: "timeDecay", minPoints: 300 }]);
  });
  it("shows defaults filled for a partial config", () => {
    expect(configValues(defaultRegistry, { mechanic: "mixed", mechanicConfig: { numberMode: "closest" } })).toEqual({ numberMode: "closest", allowChange: true, shuffleOptions: false, pollMaxStrikes: 3, pollMultiplier: 1, pollScoring: "bank", allocationKeepOneEmpty: true, buzzerLockout: true });
  });
  it("an optional text field cleared is removed from the config", () => {
    const g = copy(DEMO_GAME);
    setMechanic(g, 0, "crowd-vote", defaultRegistry);
    setConfigField(g, 0, "teamId", "t_chat");
    expect(g.format.rounds[0]?.mechanicConfig).toMatchObject({ teamId: "t_chat" });
    setConfigField(g, 0, "teamId", undefined);
    expect(g.format.rounds[0]?.mechanicConfig).not.toHaveProperty("teamId");
  });
  it("parses number lists", () => {
    expect(parseNumberList("100, 200 ;300  400")).toEqual([100, 200, 300, 400]);
    expect(parseNumberList("100, deux")).toBeNull();
  });
});

describe("roundIssues (compatibility through the mechanic init)", () => {
  it("templates have no issue", () => {
    expect(TEMPLATES.flatMap((t) => t.game.format.rounds.flatMap((_, ri) => roundIssues(t.game, ri, defaultRegistry).map((i) => `${t.id} r${ri}: ${i.message}`)))).toEqual([]);
  });
  it("mixed round: everything fits, but a survey in a solo game is flagged (team game)", () => {
    const g = copy(DEMO_GAME);
    setMechanic(g, 0, "mixed", defaultRegistry);
    expect(roundIssues(g, 0, defaultRegistry)).toEqual([]);
    const poll = DEMO_POLL_GAME.questions[0];
    if (poll === undefined) throw new Error("fixture");
    g.questions.push(poll);
    g.format.rounds[0]?.questions.push(poll.id);
    expect(roundIssues(g, 0, defaultRegistry).map((i) => i.message).join()).toMatch(/se joue en équipes/);
  });

  it("flags a question the mechanic cannot play", () => {
    const g = copy(DEMO_GAME);
    setMechanic(g, 0, "order", defaultRegistry);
    const issues = roundIssues(g, 0, defaultRegistry);
    expect(issues.map((i) => i.questionId)).toEqual(["q_capital_fr", "q_earth_flat", "q_primes"]);
    expect(issues[0]?.message).toContain("une manche « remise en ordre » ne peut pas jouer une question « QCM (une réponse) »");
  });
  it("flags an empty round, an invalid config and reserve questions", () => {
    const g = copy(DEMO_GAME);
    g.format.rounds.push(newRound(defaultRegistry, "r_new", 2));
    expect(roundIssues(g, 1, defaultRegistry)[0]?.message).toMatch(/aucune question/);
    setMechanic(g, 0, "ladder", defaultRegistry);
    setConfigField(g, 0, "steps", [300, 200]);
    expect(roundIssues(g, 0, defaultRegistry)[0]?.message).toMatch(/réglages invalides/);
    const ev = copy(DEMO_EVENING_GAME);
    addToRound(ev, 1, "q_txt_1", "reserve"); // text question in reserve of the order round
    expect(roundIssues(ev, 1, defaultRegistry).map((i) => i.questionId)).toEqual(["q_txt_1"]);
  });
  it("hints needs hints, reveal-image / pin need an image", () => {
    const g = copy(DEMO_GAME);
    const q: Question = newQuestion("text", "q_t");
    g.questions.push(q, newQuestion("pin", "q_pin"));
    g.format.rounds[0] = { ...newRound(defaultRegistry, "r_1", 1), questions: ["q_t"] };
    setMechanic(g, 0, "hints", defaultRegistry);
    expect(roundIssues(g, 0, defaultRegistry)[0]?.message).toMatch(/indice/);
    setMechanic(g, 0, "reveal-image", defaultRegistry);
    expect(roundIssues(g, 0, defaultRegistry)[0]?.message).toMatch(/image/);
  });
});

describe("round edits", () => {
  it("adds, duplicates, reorders and deletes rounds without touching the others", () => {
    const g = copy(DEMO_EVENING_GAME);
    const titles = () => g.format.rounds.map((r) => r.title);
    duplicateRound(g, 0, "r_copy");
    expect(g.format.rounds[1]).toMatchObject({ id: "r_copy", mechanic: "text-answer", questions: ["q_txt_1", "q_txt_2"] });
    moveItem(g.format.rounds, 1, 3);
    expect(g.format.rounds[3]?.id).toBe("r_copy");
    expect(deleteRound(g, 3)).toBe(true);
    expect(titles()).toEqual(copy(DEMO_EVENING_GAME).format.rounds.map((r) => r.title));
    const one = copy(DEMO_GAME);
    expect(deleteRound(one, 0)).toBe(false);
  });
  it("deleting a round removes its transitions (both ways) and node position: the document stays valid", () => {
    const g = copy(DEMO_EVENING_GAME);
    const [a, b] = g.format.rounds.map((r) => r.id);
    if (a === undefined || b === undefined) throw new Error("fixture has two rounds");
    g.format.flow = [{ from: a, to: b, when: "tie" }, { from: b, to: a, when: "always" }, { from: a, to: "end", when: "always" }];
    g.format.flowLayout = { [b]: { x: 1, y: 2 } };
    expect(deleteRound(g, 1)).toBe(true);
    expect(g.format.flow).toEqual([{ from: a, to: "end", when: "always" }]);
    expect(g.format.flowLayout).toBeUndefined();
    expect(GameDocument.safeParse(g).success).toBe(true);
  });
  it("moves questions between round and reserve, never twice in a round", () => {
    const g = copy(DEMO_EVENING_GAME);
    addToRound(g, 0, "q_txt_1", "reserve");
    expect(g.format.rounds[0]?.reserve).toEqual(["q_txt_3"]);
    swapList(g, 0, "q_txt_3", "questions");
    expect(g.format.rounds[0]).toMatchObject({ questions: ["q_txt_1", "q_txt_2", "q_txt_3"], reserve: [] });
    removeFromRound(g, 0, "q_txt_2", "questions");
    expect(g.format.rounds[0]?.questions).toEqual(["q_txt_1", "q_txt_3"]);
  });
  it("changing the mechanic resets the config to its defaults", () => {
    const g = copy(DEMO_EVENING_GAME);
    setMechanic(g, 3, "board", defaultRegistry);
    expect(g.format.rounds[3]?.mechanicConfig).toEqual(defaultConfig(defaultRegistry, "board"));
  });
  it("a multi-round format stays valid after edits (no syncRound)", () => {
    const g = copy(DEMO_EVENING_GAME);
    g.questions.push(newQuestion("order", "q_new"));
    addToRound(g, 1, "q_new", "questions");
    expect(GameDocument.safeParse(g).success).toBe(true);
    expect(g.format.rounds[0]?.questions).toEqual(["q_txt_1", "q_txt_2"]);
  });
  it("scoring blocks start valid", () => {
    expect(newScoring("penalty")).toEqual({ type: "penalty", points: -50 });
    expect(newScoring("multiplier")).toEqual({ type: "multiplier", factor: 2 });
  });
});

describe("deleteQuestion", () => {
  it("removes it from the bank, the rounds and the reserves", () => {
    const g = copy(DEMO_EVENING_GAME);
    expect(roundsOf(g, "q_txt_3")).toEqual(["1. Manche 1 — Réponse libre (réserve)"]);
    expect(deleteQuestion(g, "q_txt_3")).toEqual({ ok: true });
    expect(g.questions.some((q) => q.id === "q_txt_3")).toBe(false);
    expect(g.format.rounds[0]?.reserve).toEqual([]);
    expect(GameDocument.safeParse(g).success).toBe(true);
  });
  it("refuses when a round would become empty", () => {
    const g = copy(DEMO_EVENING_GAME);
    const r = deleteQuestion(g, "q_num_1");
    expect(r.ok).toBe(false);
    expect(g.questions.some((q) => q.id === "q_num_1")).toBe(true);
  });
});

describe("question factories", () => {
  it("every type of the menu gives a valid question", () => {
    const invalid = QUESTION_TYPES.filter((t) => {
      const g = copy(DEMO_GAME);
      g.questions.push(newQuestion(t.kind, "q_x"));
      return !GameDocument.safeParse(g).success;
    });
    expect(invalid).toEqual([]);
  });
});
