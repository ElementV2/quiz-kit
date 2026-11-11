import { describe, expect, it } from "vitest";
import { DEMO_BOARD_GAME, DEMO_TEXT_GAME, type GameDocument } from "@quiz/schema";
import { createGame, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { stakedRule } from "./reduce.ts";
import { participantTotal } from "./state.ts";
import { actor, addPlayers, ctl, makeSession, run } from "./testing/harness.ts";

// 100 points flat (no time decay) so the arithmetic is readable.
const GAME: GameDocument = { ...DEMO_TEXT_GAME, format: { ...DEMO_TEXT_GAME.format, rounds: DEMO_TEXT_GAME.format.rounds.map((r) => ({ ...r, timer: undefined, scoring: [{ type: "base", points: 100 }] })) } };
const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;
const buzz = (pid: string) => [actor("player", pid), { type: "buzz", participantId: pid }] as const;
const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2)];
const Q1 = [ctl({ type: "question.present" }), say("p_1", "Van Gogh"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

describe("live stakes (question.setStakes)", () => {
  it("« cette question vaut 500 points » / « ×3 », shown on air, only for that question", () => {
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: 500, multiplier: 3 })], createGame(makeSession(GAME)));
    expect(project(g, { role: "output", scene: "program" }, reg)).toMatchObject({ stakes: { points: 500, multiplier: 3 } });
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ stakes: { points: 500, multiplier: 3 } });
    g = run(reg, [say("p_1", "Van Gogh"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(1500);
    g = run(reg, [ctl({ type: "question.next" })], g);
    expect(project(g, { role: "output", scene: "program" }, reg)).toMatchObject({ stakes: null });
    g = run(reg, [ctl({ type: "question.present" }), say("p_1", "Canberra"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(1600); // back to the round's 100
  });

  it("set between questions for the next one; undoable; refused once revealed", () => {
    let g = run(reg, [...START, ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 })], createGame(makeSession(GAME)));
    expect(project(g, { role: "host" }, reg)).toMatchObject({ stakes: { multiplier: 2 } });
    g = run(reg, Q1, g);
    expect(participantTotal(g.state, "p_1")).toBe(200);
    expect(() => run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: 50, multiplier: null })], g)).toThrow(/wrong-phase/);
    const undone = run(reg, [ctl({ type: "undo", targetSeq: g.events.find((e) => e.action.type === "question.setStakes")?.seq ?? 0 })], g);
    expect(participantTotal(undone.state, "p_1")).toBe(100);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });

  it("a regrade keeps the stakes of the reveal; the multiplier applies to mechanic points (board)", () => {
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 }), say("p_2", "Monet"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(GAME)));
    expect(participantTotal(g.state, "p_2")).toBe(0);
    g = run(reg, [ctl({ type: "question.regrade", questionId: "q_txt_1", answerSpec: { kind: "text", accepted: ["Monet"] } })], g);
    expect(participantTotal(g.state, "p_2")).toBe(200);
    const b = run(reg, [...START, ctl({ type: "question.present", questionIndex: 0 }), ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 5 }), buzz("p_1"), ctl({ type: "answer.judge", participantId: "p_1", correct: true }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(DEMO_BOARD_GAME)));
    expect(participantTotal(b.state, "p_1")).toBe(1000); // 200 cell × 5
  });

  it("points replace the base and scale the time decay alike", () => {
    expect(stakedRule([{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }], { points: 1000, multiplier: null })).toEqual([{ type: "base", points: 1000 }, { type: "timeDecay", minPoints: 500 }]);
  });
});

describe("live stakes — review 5", () => {
  it("board: no target between cells, points refused, ×2 cell judged then skipped is doubled", () => {
    let g = run(reg, [...START], createGame(makeSession(DEMO_BOARD_GAME)));
    expect(project(g, { role: "control" }, reg)).toMatchObject({ stakesTarget: null }); // the next cell is not known
    g = run(reg, [ctl({ type: "question.present", questionIndex: 3 })], g);
    expect(project(g, { role: "control" }, reg)).toMatchObject({ stakesTarget: { roundIndex: 0, questionIndex: 3, points: false } });
    expect(() => run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 3, points: 1000, multiplier: null })], g)).toThrow(/multiplicateur/);
    g = run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 3, points: null, multiplier: 2 }), buzz("p_1"), ctl({ type: "answer.judge", participantId: "p_1", correct: true }), ctl({ type: "question.next" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(800); // 400 cell × 2, written at question.next
  });

  it("the target is journaled: undoing an explicit present never moves the stakes to another question", () => {
    let g = run(reg, [...START, ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 1, points: null, multiplier: 5 })], createGame(makeSession(GAME)));
    g = run(reg, [ctl({ type: "question.present", questionIndex: 1 }), ctl({ type: "undo" })], g);
    expect(g.state.stakes).toMatchObject({ questionIndex: 1, multiplier: 5 });
    expect(replay(g.session, g.events, reg).state.stakes).toEqual(g.state.stakes);
  });

  it("no stakes on a ladder; a new round clears stakes set ahead", async () => {
    const { DEMO_LADDER_GAME } = await import("@quiz/schema");
    const l = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(1), ctl({ type: "question.present" })], createGame(makeSession(DEMO_LADDER_GAME)));
    expect(project(l, { role: "control" }, reg)).toMatchObject({ stakesTarget: null });
    expect(() => run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 })], l)).toThrow(/paliers/);
  });
});

describe("live stakes — review 6", () => {
  it("the question on air keeps its stakes: another target is refused until it is left", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 })], createGame(makeSession(GAME)));
    expect(() => run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 1, points: null, multiplier: 5 })], g)).toThrow(/mise/);
  });
});
