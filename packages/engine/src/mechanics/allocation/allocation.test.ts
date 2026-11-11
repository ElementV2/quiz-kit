import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { DEMO_ALLOCATION_GAME, type Action } from "@quiz/schema";
import { allocation } from "./allocation.ts";

mechanicContractSuite({
  mechanic: allocation,
  registry: reg,
  game: DEMO_ALLOCATION_GAME,
  answerFor: (_v, picks, pid, control): Action | null => {
    const m = control.mechanic;
    if (m?.mechanic !== "allocation") return null;
    const [a, b] = m.options;
    if (a === undefined || b === undefined) return null;
    const split = ((picks[0] ?? 0) % 11) * 1000;
    return { type: "answer.submit", participantId: pid, answer: { kind: "allocation", amounts: [{ optionId: a.id, amount: split }, { optionId: b.id, amount: m.budget - split }] } };
  },
});

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" })];

const put = (pid: string, amounts: [string, number][]) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "allocation", amounts: amounts.map(([optionId, amount]) => ({ optionId, amount })) } }] as const;

describe("allocation", () => {
  it("wins what sits on the right option, needs the whole budget and one empty option", () => {
    const g = run(reg, OPEN, createGame(makeSession(DEMO_ALLOCATION_GAME)));
    expect(() => run(reg, [put("p_1", [["a", 5000], ["b", 4000]])], g)).toThrow(/invalid/);
    expect(() => run(reg, [put("p_1", [["a", 2500], ["b", 2500], ["c", 2500], ["d", 2500]])], g)).toThrow(/vide/);
    const done = run(reg, [put("p_1", [["b", 7000], ["c", 3000]]), put("p_2", [["a", 10_000]]), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(done.state, "p_1")).toBe(7000);
    expect(participantTotal(done.state, "p_2")).toBe(0);
    expect(project(done, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct", myAnswer: ["a:0", "b:7000", "c:3000", "d:0"] });
    expect(project(done, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ correct: "b", counts: { a: 10_000, b: 7000, c: 3000, d: 0 } });
  });
});
