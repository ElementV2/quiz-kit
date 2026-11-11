import { describe, expect, it } from "vitest";
import { DEMO_BOARD_GAME, DEMO_GAME } from "@quiz/schema";
import { createGame, decide, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { actor, addPlayers, ctl, makeSession, run } from "./testing/harness.ts";

const skip = (questionIndex: number, roundIndex = 0) => ctl({ type: "question.skip", roundIndex, questionIndex });
const started = () => run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2)], createGame(makeSession(DEMO_GAME)));
const HOST = actor("host", "h");

describe("question.skip (pass the upcoming question between two questions)", () => {
  it("passes the next question without playing it; the one after is presented; nothing scored", () => {
    const g = started();
    const passed = run(reg, [skip(0)], g);
    expect(passed.state).toMatchObject({ phase: "idle", questionIndex: 0 });
    expect(passed.state.ledger).toEqual(g.state.ledger);
    expect(run(reg, [ctl({ type: "question.present" })], passed).state.questionIndex).toBe(1);
  });

  it("a duplicate press is refused (explicit target), and question.next between questions still does nothing", () => {
    const passed = run(reg, [skip(0)], started());
    expect(() => run(reg, [skip(0)], passed)).toThrow(/plus la suivante/);
    expect(() => run(reg, [ctl({ type: "question.next" })], passed)).toThrow(/aucune question en cours/);
  });

  it("passing the last question ends the round; refused on air and on a board", () => {
    const n = DEMO_GAME.format.rounds[0]?.questions.length ?? 0;
    const g = run(reg, Array.from({ length: n }, (_, i) => skip(i)), started());
    expect(["round.end", "game.end"]).toContain(g.state.phase);
    expect(() => run(reg, [ctl({ type: "question.present" }), skip(1)], started())).toThrow(/entre deux questions/);
    const board = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(1)], createGame(makeSession(DEMO_BOARD_GAME)));
    expect(() => run(reg, [skip(0)], board)).toThrow(/plateau/);
  });

  it("after a played question, the last one — unplayable by the round — is passed and ends the round", () => {
    const doc = structuredClone(DEMO_GAME);
    const r0 = doc.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    doc.questions.push({ id: "q_poll_bad", prompt: { text: "Sondage dans une manche QCM ?" }, answerSpec: { kind: "text", accepted: ["x"] }, hints: [], tags: [] });
    r0.questions = [r0.questions[0] ?? "", "q_poll_bad"];
    const g = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(1), ctl({ type: "question.present" }), ctl({ type: "question.open" }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], createGame(makeSession(doc)));
    expect(() => run(reg, [ctl({ type: "question.present" })], g)).toThrow(/ne peut pas jouer/);
    expect(["round.end", "game.end"]).toContain(run(reg, [skip(1)], g).state.phase);
  });

  it("drops stakes set on the passed question; undo restores it; replay identical", () => {
    const g = run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 3 }), skip(0)], started());
    expect(g.state.stakes).toBeNull();
    const u = run(reg, [ctl({ type: "undo" })], g);
    expect(u.state).toMatchObject({ questionIndex: null, stakes: { multiplier: 3 } });
    expect(replay(u.session, u.events, reg).state).toEqual(u.state);
  });

  it("the host may pass a question only while driving", () => {
    const g = started();
    const asHost = (from: typeof g) => decide(from, { action: { type: "question.skip", roundIndex: 0, questionIndex: 0 }, actor: HOST, idempotencyKey: null }, 9e12, reg);
    expect(asHost(g).ok).toBe(false);
    expect(asHost(run(reg, [ctl({ type: "host.setDrive", enabled: true })], g)).ok).toBe(true);
  });
});
