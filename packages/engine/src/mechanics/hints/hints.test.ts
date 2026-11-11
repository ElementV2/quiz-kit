import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { DEMO_HINTS_GAME, type GameDocument } from "@quiz/schema";
import { progressiveAnswer, revealNext } from "../shared/progressive.testing.ts";
import { hints } from "./hints.ts";

mechanicContractSuite({
  mechanic: hints,
  registry: reg,
  game: DEMO_HINTS_GAME,
  answerFor: (_v, picks, pid, control) => (control.mechanic?.mechanic === "hints" ? progressiveAnswer(picks, pid, control.mechanic) : null),
  controlActionFor: revealNext,
  // Hidden hints never reach a tablet or an output.
  assertNoLeak: (v, control) => {
    const m = v.mechanic;
    const c = control.mechanic;
    if (m?.mechanic === "hints" && c?.mechanic === "hints" && v.phase !== "revealed" && JSON.stringify(m.hints) !== JSON.stringify(c.hints.slice(0, c.hintCount))) throw new Error("hidden hints leaked");
  },
});

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3), ctl({ type: "question.present" })];
const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;

describe("hints", () => {
  it("the earlier the right answer, the more points (frozen when answering)", () => {
    let g = run(reg, [...OPEN, say("p_1", "marie curie")], createGame(makeSession(DEMO_HINTS_GAME)));
    expect(project(g, { role: "player", participantId: "p_2" }, reg).mechanic).toMatchObject({ hints: ["Je suis née à Varsovie."], hintCount: 1, points: 100 });
    g = run(reg, [ctl({ type: "element.reveal", index: 1 }), say("p_2", "Curie"), ctl({ type: "element.reveal", index: 2 }), say("p_3", "Marie Curie")], g);
    expect(() => run(reg, [ctl({ type: "element.reveal", index: 2 })], g)).toThrow(/conflict/);
    g = run(reg, [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect([participantTotal(g.state, "p_1"), participantTotal(g.state, "p_2"), participantTotal(g.state, "p_3")]).toEqual([100, 55, 10]);
  });

  it("refuses a second answer by default and a question without hints", () => {
    const g = run(reg, [...OPEN, say("p_1", "Pasteur")], createGame(makeSession(DEMO_HINTS_GAME)));
    expect(() => run(reg, [say("p_1", "Curie")], g)).toThrow(/conflict/);
    const noHints: GameDocument = { ...DEMO_HINTS_GAME, questions: DEMO_HINTS_GAME.questions.map((q) => ({ ...q, hints: [] })) };
    expect(() => run(reg, OPEN, createGame(makeSession(noHints)))).toThrow(/aucun indice/);
  });
});
