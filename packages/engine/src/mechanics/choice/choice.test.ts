import { describe, expect, it } from "vitest";
import { DEMO_GAME, type Action, type Question, type View } from "@quiz/schema";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { addPlayers, answer, ctl, run } from "../../testing/harness.ts";
import { choice } from "./choice.ts";

const answerFor = (view: View, picks: readonly number[]): Action | null => {
  const m = view.mechanic;
  if (m === null || m.mechanic !== "choice") return { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } };
  const ids = [...new Set(picks.map((p) => m.options[p % m.options.length]?.id ?? "a"))].slice(0, m.maxPick);
  return { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ids } };
};

mechanicContractSuite({ mechanic: choice, registry: reg, game: DEMO_GAME, answerFor });

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" })];

describe("choice projections", () => {
  it("hides the correct answer and distribution from players and outputs until reveal", () => {
    const g = run(reg, [...OPEN, answer("p_1", "b"), ctl({ type: "question.lock" })]);
    for (const v of [project(g, { role: "player", participantId: "p_2" }, reg), project(g, { role: "output", scene: "program" }, reg)]) {
      expect(v.mechanic).toMatchObject({ correct: null, counts: null });
    }
    expect(project(g, { role: "host" }, reg).mechanic).toMatchObject({ correct: ["b"], counts: { a: 0, b: 1, c: 0, d: 0 } });
  });

  it("reveals correct answer, distribution and the player's own result", () => {
    const g = run(reg, [...OPEN, answer("p_1", "b"), answer("p_2", "a"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })]);
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ correct: ["b"], counts: { a: 1, b: 1 } });
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
    expect(project(g, { role: "seat", seat: 2 }, reg)).toMatchObject({ myResult: "wrong", me: { participantId: "p_2" } });
  });

  it("never exposes other players' answers or host notes to a player", () => {
    const g = run(reg, [...OPEN, answer("p_1", "b")]);
    const json = JSON.stringify(project(g, { role: "player", participantId: "p_2" }, reg));
    expect(json).not.toContain("Hugues Capet");
    expect(project(g, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myAnswer: null });
    expect(project(g, { role: "host" }, reg)).toMatchObject({ notes: expect.stringContaining("Hugues Capet") });
  });

  it("validates picks against min/max and known options", () => {
    const g = run(reg, OPEN);
    for (const ids of [["a", "b"], ["z"], ["a", "a"]]) {
      expect(() => run(reg, [answer("p_1", ...ids)], g)).toThrow(/rejected/);
    }
  });

  it("refuses poll / oral questions", () => {
    const oral: Question = { id: "q_oral", prompt: { text: "?" }, answerSpec: { kind: "oral", expected: "x" }, hints: [], tags: [] };
    const r = choice.init({}, oral, { at: 0, phase: "idle", lockedAt: null, rng: { next: () => 0, int: () => 0, shuffle: (x) => [...x] } }, { previous: null, questionIndex: 0, questionsLeft: 0, questions: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});
