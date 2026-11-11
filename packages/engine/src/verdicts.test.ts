import { describe, expect, it } from "vitest";
import { DEMO_GAME } from "@quiz/schema";
import { createGame, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { participantTotal } from "./state.ts";
import { addPlayers, answer, ctl, makeSession, run, type Step } from "./testing/harness.ts";

const q = DEMO_GAME.questions[0];
const right = q?.answerSpec.kind === "single" ? q.answerSpec.correct : "";
const wrong = q?.answerSpec.kind === "single" ? (q.answerSpec.options.find((o) => o.id !== right)?.id ?? "") : "";
const OPEN: Step[] = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3), ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", right), answer("p_2", wrong)];
const LOCK: Step[] = [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];
const force = (participantId: string, correct: boolean | null): Step => ctl({ type: "answer.verdict", roundIndex: 0, questionIndex: 0, participantId, correct });
const total = (g: ReturnType<typeof run>, pid: string) => participantTotal(g.state, pid);
const control = (g: ReturnType<typeof run>) => {
  const v = project(g, { role: "control" }, reg);
  if (v.role !== "control") throw new Error("control");
  return v;
};

describe("answer.verdict: the control room corrects one player's verdict (any mechanic)", () => {
  it("before the reveal: a cheat counted wrong, a fair answer counted right; tablets and control see it", () => {
    const g = run(reg, [...OPEN, force("p_1", false), force("p_2", true), ...LOCK], createGame(makeSession(DEMO_GAME)));
    expect(total(g, "p_1")).toBe(0);
    expect(total(g, "p_2")).toBeGreaterThan(0);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "wrong" });
    expect(control(g).verdicts).toEqual(expect.arrayContaining([{ participantId: "p_1", auto: true, forced: false }, { participantId: "p_2", auto: false, forced: true }]));
  });

  it("after the reveal: points rewritten at once; back to automatic restores them; undo and replay agree", () => {
    const g = run(reg, [...OPEN, ...LOCK], createGame(makeSession(DEMO_GAME)));
    const before = total(g, "p_1");
    expect(before).toBeGreaterThan(0);
    const cheat = run(reg, [force("p_1", false)], g);
    expect(total(cheat, "p_1")).toBe(0);
    expect(total(run(reg, [force("p_1", null)], cheat), "p_1")).toBe(before);
    expect(total(run(reg, [ctl({ type: "undo" })], cheat), "p_1")).toBe(before);
    expect(replay(cheat.session, cheat.events, reg).state).toEqual(cheat.state);
    // a player who did not answer, counted right by hand
    expect(total(run(reg, [force("p_3", true)], g), "p_3")).toBeGreaterThan(0);
  });

  it("on a question already left (history), and kept by a later regrade of the question", () => {
    const g = run(reg, [...OPEN, ...LOCK, ctl({ type: "question.next" }), force("p_1", false)], createGame(makeSession(DEMO_GAME)));
    expect(total(g, "p_1")).toBe(0);
    if (q?.answerSpec.kind !== "single") throw new Error("fixture");
    const r = run(reg, [ctl({ type: "question.regrade", questionId: q.id, answerSpec: { ...q.answerSpec, correct: wrong } })], g);
    expect(total(r, "p_2")).toBeGreaterThan(0); // regraded: p_2 is now right
    expect(total(r, "p_1")).toBe(0); // still forced wrong
  });

  it("refuses a question never played and an unknown player", () => {
    const g = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(1)], createGame(makeSession(DEMO_GAME)));
    expect(() => run(reg, [force("p_1", true)], g)).toThrow(/pas encore jouée/);
    expect(() => run(reg, [...OPEN, force("p_9", true)], createGame(makeSession(DEMO_GAME)))).toThrow(/joueur inconnu/);
  });
});
