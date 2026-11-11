import { describe, expect, it } from "vitest";
import { DEMO_BOARD_GAME, type Action, type GameDocument } from "@quiz/schema";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { board, boardCells } from "./board.ts";

mechanicContractSuite({
  mechanic: board,
  registry: reg,
  game: DEMO_BOARD_GAME,
  answerFor: (_v, _picks, pid): Action => ({ type: "buzz", participantId: pid }),
  controlActionFor: (control, picks): Action | null => {
    const m = control.mechanic;
    if (m?.mechanic !== "board" || m.hand === null) return null;
    return { type: "answer.judge", participantId: m.hand, correct: (picks[0] ?? 0) % 2 === 0 };
  },
  assertNoLeak: (v) => {
    if (v.mechanic?.mechanic === "board" && v.phase !== "revealed" && v.mechanic.correct !== null) throw new Error("board answer leaked");
  },
});

const buzz = (pid: string) => [actor("player", pid), { type: "buzz", participantId: pid }] as const;
const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2)];
const g0 = () => createGame(makeSession(DEMO_BOARD_GAME));

describe("board", () => {
  it("builds the grid from tags and values (rows past `values` keep the step)", () => {
    const cells = boardCells(DEMO_BOARD_GAME.questions, [200, 400]);
    expect(cells.map((c) => [c.category, c.value])).toEqual([["Sciences", 200], ["Sciences", 400], ["Géographie", 200], ["Géographie", 400], ["Lettres", 200], ["Lettres", 400]]);
    expect(boardCells([...DEMO_BOARD_GAME.questions.slice(0, 2), { ...DEMO_BOARD_GAME.questions[0]!, id: "q_x" }], [100, 300]).map((c) => c.value)).toEqual([100, 300, 500]); // oxlint-disable-line typescript/no-non-null-assertion -- fixture
  });

  it("shows the grid between cells, plays cells in any order, + value / − value", () => {
    let g = run(reg, START, g0());
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ mechanic: "board", cell: null, categories: [{ name: "Sciences" }, { name: "Géographie" }, { name: "Lettres" }] });
    g = run(reg, [ctl({ type: "question.present", questionIndex: 3 }), ctl({ type: "question.open" }), buzz("p_1"), buzz("p_2"), ctl({ type: "answer.judge", participantId: "p_1", correct: false }), ctl({ type: "answer.judge", participantId: "p_2", correct: true }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(-400);
    expect(participantTotal(g.state, "p_2")).toBe(400);
    g = run(reg, [ctl({ type: "question.next" })], g);
    expect(g.state.phase).toBe("idle");
    const between = project(g, { role: "player", participantId: "p_1" }, reg).mechanic;
    expect(between).toMatchObject({ mechanic: "board", cell: null });
    if (between?.mechanic !== "board") throw new Error("board");
    expect(between.categories[1]?.cells.map((c) => c.played)).toEqual([false, true]);
    // A played cell is refused; without index the first free cell is taken.
    expect(() => run(reg, [ctl({ type: "question.present", questionIndex: 3 })], g)).toThrow(/déjà jouée/);
    g = run(reg, [ctl({ type: "question.present" })], g);
    expect(g.state.questionIndex).toBe(0);
  });

  it("ends the round when every cell is played, whatever the order", () => {
    let g = run(reg, START, g0());
    for (const i of [5, 0, 4, 1, 3, 2]) g = run(reg, [ctl({ type: "question.present", questionIndex: i }), ctl({ type: "question.open" }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], g);
    expect(g.state.phase).toBe("game.end");
  });

  it("never sends the expected answer to a tablet before the reveal", () => {
    const g = run(reg, [...START, ctl({ type: "question.present", questionIndex: 4 }), ctl({ type: "question.open" }), buzz("p_1")], g0());
    expect(JSON.stringify(project(g, { role: "player", participantId: "p_2" }, reg))).not.toContain("Hugo");
    expect(project(g, { role: "host" }, reg).mechanic).toMatchObject({ correct: "Victor Hugo", hand: "p_1" });
  });

  it("refuses round.start while cells are left, whatever cell was played last", () => {
    const g = run(reg, [...START, ctl({ type: "question.present", questionIndex: 5 }), ctl({ type: "question.open" }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], g0());
    expect(() => run(reg, [ctl({ type: "round.start" })], g)).toThrow(/conflict/);
  });

  it("a cell judged right then skipped keeps its value; undo of next / present restores the grid", () => {
    let g = run(reg, [...START, ctl({ type: "question.present", questionIndex: 1 }), ctl({ type: "question.open" }), buzz("p_1"), ctl({ type: "answer.judge", participantId: "p_1", correct: true }), ctl({ type: "question.next" })], g0());
    expect(participantTotal(g.state, "p_1")).toBe(400);
    g = run(reg, [ctl({ type: "undo" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(0);
    expect(g.state.phase).toBe("open");
    g = run(reg, [ctl({ type: "question.next" }), ctl({ type: "question.present", questionIndex: 2 }), ctl({ type: "undo" })], g);
    expect(g.state.phase).toBe("idle");
    const v = project(g, { role: "output", scene: "program" }, reg).mechanic;
    if (v?.mechanic !== "board") throw new Error("board");
    expect(v.categories.flatMap((c) => c.cells).filter((c) => c.played).map((c) => c.questionIndex)).toEqual([1]);
  });

  it("questions the board cannot play get no cell and never block the end of the round", () => {
    const withNumber: GameDocument = {
      ...DEMO_BOARD_GAME,
      questions: [...DEMO_BOARD_GAME.questions.slice(0, 2), { id: "q_n", prompt: { text: "?" }, answerSpec: { kind: "number", correct: 1, tolerance: 0 }, hints: [], tags: ["Sciences"] }],
      format: { ...DEMO_BOARD_GAME.format, rounds: DEMO_BOARD_GAME.format.rounds.map((r) => ({ ...r, questions: ["q_brd_1", "q_brd_2", "q_n"] })) },
    };
    let g = run(reg, START, createGame(makeSession(withNumber)));
    for (const i of [0, 1]) g = run(reg, [ctl({ type: "question.present", questionIndex: i }), ctl({ type: "question.open" }), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], g);
    expect(g.state.phase).toBe("game.end");
  });
});
