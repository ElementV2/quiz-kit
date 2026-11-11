import { describe, expect, it } from "vitest";
import { defaultRegistry } from "@quiz/engine";
import { DEMO_CHAIN_GAME, type GameDocument } from "@quiz/schema";
import { CHAIN_NO_STEPS, MECHANICS, configValues, fieldShown, roundIssues, setConfigField, setMechanic } from "./format-logic.ts";
import { simulateView } from "./studio-logic.ts";

/** Format card of a « La chaîne » round: amounts required, optional bank target, fields by stage. */
const copy = (g: GameDocument): GameDocument => structuredClone(g);

describe("chain round settings", () => {
  it("a new chain round has no amount: said once for the round, in French", () => {
    const g = copy(DEMO_CHAIN_GAME);
    setMechanic(g, 0, "buzzer", defaultRegistry);
    setMechanic(g, 0, "chain", defaultRegistry);
    expect(g.format.rounds[0]?.mechanicConfig).toMatchObject({ stage: "chain", steps: [] });
    expect(roundIssues(g, 0, defaultRegistry)).toEqual([{ questionId: null, message: CHAIN_NO_STEPS }]);
    setConfigField(g, 0, "steps", [20, 50, 100]);
    expect(roundIssues(g, 0, defaultRegistry)).toEqual([]);
  });

  it("the duel needs no amount; decreasing amounts are refused with the engine's French message", () => {
    const g = copy(DEMO_CHAIN_GAME);
    expect(roundIssues(g, 2, defaultRegistry)).toEqual([]);
    setConfigField(g, 0, "steps", [100, 50]);
    expect(roundIssues(g, 0, defaultRegistry)[0]?.message).toMatch(/strictement croissants/);
  });

  it("an empty bank target is removed (the last amount applies)", () => {
    const g = copy(DEMO_CHAIN_GAME);
    setConfigField(g, 0, "bankTarget", 500);
    expect(g.format.rounds[0]?.mechanicConfig).toMatchObject({ bankTarget: 500 });
    setConfigField(g, 0, "bankTarget", undefined);
    expect(g.format.rounds[0]?.mechanicConfig).not.toHaveProperty("bankTarget");
    expect(roundIssues(g, 0, defaultRegistry)).toEqual([]);
  });

  it("shows the amounts for a chain round, the length for the duel", () => {
    const fields = MECHANICS["chain"]?.fields ?? [];
    const shown = (round: number) => fields.filter((f) => fieldShown(f, configValues(defaultRegistry, DEMO_CHAIN_GAME.format.rounds[round] ?? { mechanic: "chain", mechanicConfig: {} }))).map((f) => f.key);
    expect(shown(0)).toEqual(["stage", "steps", "bankTarget"]);
    expect(shown(2)).toEqual(["stage", "questionsEach"]);
  });
});

describe("scene preview of a chain round", () => {
  it("the questions before are answered right: the chain shows climbed steps", () => {
    const v = simulateView(DEMO_CHAIN_GAME, "presenting", 2);
    expect(v?.mechanic).toMatchObject({ mechanic: "chain", level: 2, chainValue: 50, expected: null });
  });
});
