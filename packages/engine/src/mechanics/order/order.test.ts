import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { DEMO_ORDER_GAME, type Action } from "@quiz/schema";
import { order } from "./order.ts";

const rotate = <T,>(xs: readonly T[], n: number): T[] => xs.map((_, i) => xs[(i + n) % xs.length]).filter((x) => x !== undefined);

mechanicContractSuite({
  mechanic: order,
  registry: reg,
  game: DEMO_ORDER_GAME,
  answerFor: (v, picks, pid, control): Action | null => {
    const m = control.mechanic;
    if (m?.mechanic !== "order") return null;
    const ids = (picks[0] ?? 0) % 2 === 0 && m.correct !== null ? m.correct : rotate(m.options.map((o) => o.id), picks[1] ?? 1);
    return { type: "answer.submit", participantId: pid, answer: { kind: "order", optionIds: ids } };
  },
  controlActionFor: (control, picks): Action | null => {
    const a = control.answers[(picks[0] ?? 0) % Math.max(control.answers.length, 1)];
    return a === undefined ? null : { type: "answer.judge", participantId: a.participantId, correct: (picks[1] ?? 0) % 2 === 0 };
  },
});

const submitOrder = (pid: string, ids: string[]) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "order", optionIds: ids } }] as const;
const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" }), ctl({ type: "question.open" })];

describe("order", () => {
  it("shows a shuffled order, never the answer, and scores the exact order", () => {
    const g = run(reg, OPEN, createGame(makeSession(DEMO_ORDER_GAME)));
    const v = project(g, { role: "player", participantId: "p_1" }, reg).mechanic;
    if (v?.mechanic !== "order") throw new Error("order view");
    expect(v.correct).toBeNull();
    expect(v.options.map((o) => o.id)).not.toEqual(["a", "b", "c", "d"]);
    expect(() => run(reg, [submitOrder("p_1", ["a", "b", "c"])], g)).toThrow(/invalid/);
    expect(() => run(reg, [submitOrder("p_1", ["a", "a", "b", "c"])], g)).toThrow(/invalid/);
    const done = run(reg, [submitOrder("p_1", ["a", "b", "c", "d"]), submitOrder("p_2", ["b", "a", "c", "d"]), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(done.state, "p_1")).toBeGreaterThan(0);
    expect(participantTotal(done.state, "p_2")).toBe(0);
  });
});
