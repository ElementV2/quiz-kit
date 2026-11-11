import { describe, expect, it } from "vitest";
import { ChainMechanicView } from "@quiz/schema";
import { chainCanBank, chainFinished, chainOverText, chainSteps, duelScores } from "./chain.ts";

const view = (over: Partial<ChainMechanicView> = {}): ChainMechanicView =>
  ChainMechanicView.parse({
    mechanic: "chain",
    roundIndex: 0,
    stage: "chain",
    order: ["p_a", "p_b"],
    turn: "p_a",
    expected: null,
    verdict: null,
    steps: [20, 50, 100],
    level: 0,
    chainValue: 0,
    bank: 0,
    bankTarget: 100,
    totalBank: 0,
    over: null,
    stats: [{ participantId: "p_a", right: 0, wrong: 0, banked: 0 }, { participantId: "p_b", right: 0, wrong: 0, banked: 0 }],
    strongest: "p_a",
    weakest: "p_a",
    vote: null,
    eliminations: [],
    duel: null,
    ...over,
  });

describe("chain view helpers", () => {
  it("lists the steps top-down: climbed below, current lit, next to reach", () => {
    expect(chainSteps(view({ level: 0 })).map((s) => s.state)).toEqual(["idle", "idle", "next"]);
    expect(chainSteps(view({ level: 2 })).map((s) => [s.amount, s.state])).toEqual([[100, "next"], [50, "current"], [20, "climbed"]]);
    expect(chainSteps(view({ level: 3 }))[0]?.state).toBe("current");
  });

  it("bank only on air, before the verdict, with something at stake, in a chain round", () => {
    expect(chainCanBank(view({ level: 1, chainValue: 20 }), "presenting")).toBe(true);
    expect(chainCanBank(view({ level: 0, chainValue: 0 }), "presenting")).toBe(false);
    expect(chainCanBank(view({ level: 1, chainValue: 20, verdict: "right" }), "presenting")).toBe(false);
    expect(chainCanBank(view({ level: 1, chainValue: 20 }), "idle")).toBe(false);
    expect(chainCanBank(view({ level: 1, chainValue: 20, over: "ended" }), "open")).toBe(false);
    expect(chainCanBank(view({ stage: "duel", level: 1, chainValue: 20 }), "open")).toBe(false);
  });

  it("finished when the round is over or the duel is won; the reason in words", () => {
    expect(chainFinished(view())).toBe(false);
    expect(chainFinished(view({ over: "target" }))).toBe(true);
    expect(chainFinished(view({ stage: "duel", steps: [], duel: { questionsEach: 5, suddenDeath: false, winner: "p_b" } }))).toBe(true);
    expect(chainOverText("ended")).toMatch(/Temps écoulé/);
    expect(chainOverText(null)).toBeNull();
  });

  it("duel score: right answers out of the questions asked, in turn order", () => {
    const v = view({ stage: "duel", stats: [{ participantId: "p_a", right: 2, wrong: 1, banked: 0 }, { participantId: "p_b", right: 1, wrong: 1, banked: 0 }] });
    expect(duelScores(v)).toEqual([{ participantId: "p_a", right: 2, asked: 3 }, { participantId: "p_b", right: 1, asked: 2 }]);
  });
});
