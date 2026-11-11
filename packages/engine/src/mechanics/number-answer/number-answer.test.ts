import { describe, expect, it } from "vitest";
import { DEMO_NUMBER_GAME, type Action, type GameDocument } from "@quiz/schema";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { numberAnswer } from "./number-answer.ts";

mechanicContractSuite({
  mechanic: numberAnswer,
  registry: reg,
  game: DEMO_NUMBER_GAME,
  answerFor: (_v, picks, pid, control): Action => {
    const m = control.mechanic;
    const right = m?.mechanic === "number-answer" ? (m.correct ?? 0) : 0;
    return { type: "answer.submit", participantId: pid, answer: { kind: "number", value: right + ((picks[0] ?? 0) % 7) - 3 } };
  },
  controlActionFor: (control, picks): Action | null => {
    const a = control.answers[(picks[0] ?? 0) % Math.max(control.answers.length, 1)];
    return a === undefined ? null : { type: "answer.judge", participantId: a.participantId, correct: (picks[1] ?? 0) % 2 === 0 };
  },
});

const num = (pid: string, value: number) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "number", value } }] as const;
const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3), ctl({ type: "question.present" })];
const tolerance: GameDocument = { ...DEMO_NUMBER_GAME, format: { ...DEMO_NUMBER_GAME.format, rounds: DEMO_NUMBER_GAME.format.rounds.map((r) => ({ ...r, mechanicConfig: { mode: "tolerance" } })) } };

describe("number-answer", () => {
  it("closest mode: the closest answers win, ties included", () => {
    const g = run(reg, [...OPEN, num("p_1", 200), num("p_2", 220), num("p_3", 200), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(DEMO_NUMBER_GAME)));
    expect(participantTotal(g.state, "p_1")).toBeGreaterThan(0);
    expect(participantTotal(g.state, "p_3")).toBeGreaterThan(0);
    expect(participantTotal(g.state, "p_2")).toBe(0);
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ correct: 206, ranking: [{ gap: 6, win: true }, { gap: 6, win: true }, { gap: 14, win: false }] });
  });

  it("tolerance mode: right within the tolerance only", () => {
    const steps = [...OPEN, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" }), ctl({ type: "question.present" }), num("p_1", 321), num("p_2", 345)];
    const g = run(reg, [...steps, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(tolerance)));
    expect(participantTotal(g.state, "p_1")).toBeGreaterThan(0);
    expect(participantTotal(g.state, "p_2")).toBe(0);
  });

  it("refuses values out of range and hides the ranking from players before reveal", () => {
    const g = run(reg, [...OPEN, num("p_1", 100)], createGame(makeSession(DEMO_NUMBER_GAME)));
    expect(() => run(reg, [num("p_2", 5000)], g)).toThrow(/invalid/);
    const locked = run(reg, [ctl({ type: "question.lock" })], g);
    expect(project(locked, { role: "player", participantId: "p_1" }, reg).mechanic).toMatchObject({ correct: null, ranking: null, tolerance: null });
    expect(project(locked, { role: "host" }, reg).mechanic).toMatchObject({ correct: 206, ranking: [{ participantId: "p_1" }] });
  });
});
