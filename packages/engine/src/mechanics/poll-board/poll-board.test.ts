import { describe, expect, it } from "vitest";
import { DEMO_POLL_GAME, type Action, type ControlView, type GameDocument, type PollBoardMechanicView, type Question, type View } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { createRng } from "../../rng.ts";
import { teamTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { addPlayers, CONTROL, ctl, makeSession, run, type Step } from "../../testing/harness.ts";
import { pollBoard } from "./poll-board.ts";

// ---------------------------------------------------------------------------------------------
// Contract suite: the generator plays like an operator (gives the hand, judges, steals, reveals).
// ---------------------------------------------------------------------------------------------

function pollOf(v: View | ControlView): PollBoardMechanicView | null {
  return v.mechanic?.mechanic === "poll-board" ? v.mechanic : null;
}

const TEAMS = ["t_a", "t_b"] as const;

function controlActionFor(control: ControlView, picks: readonly number[]): Action | null {
  const m = pollOf(control);
  const [p0 = 0, p1 = 0, p2 = 0] = picks;
  if (m === null) return { type: "poll.control", teamId: "t_a" };
  // One time in five: any action, valid or not (exercises rejections).
  if (p0 % 5 === 0) {
    const pick = p1 % 5;
    const options: Action[] = [
      { type: "poll.control", teamId: TEAMS[p2 % 2] ?? "t_a" },
      { type: "poll.steal", teamId: TEAMS[p2 % 2] ?? "t_a" },
      { type: "element.reveal", index: p2 % (m.slots.length + 1) },
      { type: "answer.judge", correct: true, optionId: "a" },
      { type: "answer.judge", correct: false },
    ];
    return options[pick] ?? null;
  }
  const hidden = m.slots.filter((s) => !s.revealed);
  const other = TEAMS.find((t) => t !== m.controllingTeamId) ?? "t_b";
  if (m.controllingTeamId === null) return { type: "poll.control", teamId: TEAMS[p1 % 2] ?? "t_a" };
  if (m.stage === "steal" && m.stealingTeamId === null) return { type: "poll.steal", teamId: other };
  if (m.stage === "done") {
    const slot = hidden[p1 % Math.max(hidden.length, 1)];
    return slot === undefined ? null : { type: "element.reveal", index: slot.index };
  }
  const slot = hidden[p1 % Math.max(hidden.length, 1)];
  // The control view knows the options: the operator matches the spoken answer to a slot.
  const optionId = slot === undefined ? null : optionIdOf(control, slot.index);
  return p2 % 3 === 0 || optionId === null ? { type: "answer.judge", correct: false } : { type: "answer.judge", correct: true, optionId };
}

/** Option id of a slot, read from the full question (control knows it). */
function optionIdOf(control: ControlView, index: number): string | null {
  const q = DEMO_POLL_GAME.questions.find((x) => x.id === control.question?.id);
  if (q === undefined || q.answerSpec.kind !== "poll") return null;
  const label = pollOf(control)?.slots[index]?.label ?? null;
  return q.answerSpec.options.find((o) => o.label === label)?.id ?? null;
}

function assertNoLeak(view: View, control: ControlView): void {
  const m = pollOf(view);
  const full = pollOf(control);
  if (m === null || full === null) return;
  const json = JSON.stringify(view);
  for (const [i, slot] of m.slots.entries()) {
    const truth = full.slots[i];
    if (truth === undefined) throw new Error("slot count differs between views");
    if (slot.revealed) {
      expect(slot, "revealed slot differs from control").toEqual(truth);
    } else {
      expect(slot.label, `masked slot ${i} label leaked to ${view.role}`).toBeNull();
      expect(slot.value, `masked slot ${i} value leaked to ${view.role}`).toBeNull();
      expect(json, `masked slot ${i} label leaked to ${view.role}`).not.toContain(JSON.stringify(truth.label));
    }
  }
}

/** Two rounds so that properties go through round.end / round.start too. */
const CONTRACT_GAME: GameDocument = {
  ...DEMO_POLL_GAME,
  format: {
    ...DEMO_POLL_GAME.format,
    rounds: DEMO_POLL_GAME.format.rounds.flatMap((r) => [r, { ...r, id: `${r.id}_x2`, title: `${r.title} (x2)`, mechanicConfig: { maxStrikes: 1, multiplier: 2 } }]),
  },
};

mechanicContractSuite({ mechanic: pollBoard, registry: reg, game: CONTRACT_GAME, answerFor: () => null, controlActionFor, assertNoLeak });

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const teams: Step[] = [
  ctl({ type: "team.add", teamId: "t_a", name: "Les Rouges", color: "#ff0000" }),
  ctl({ type: "team.add", teamId: "t_b", name: "Les Bleus", color: "#0000ff" }),
];
const roster: Step[] = [
  ...teams,
  ...addPlayers(4),
  ctl({ type: "player.setTeam", participantId: "p_1", teamId: "t_a" }),
  ctl({ type: "player.setTeam", participantId: "p_2", teamId: "t_a" }),
  ctl({ type: "player.setTeam", participantId: "p_3", teamId: "t_b" }),
  ctl({ type: "player.setTeam", participantId: "p_4", teamId: "t_b" }),
];
const PRESENTED: Step[] = [ctl({ type: "game.start" }), ...roster, ctl({ type: "round.start" }), ctl({ type: "question.present" })];
const OPEN: Step[] = [...PRESENTED, ctl({ type: "poll.control", teamId: "t_a" }), ctl({ type: "question.open" })];

const good = (optionId: string): Step => ctl({ type: "answer.judge", correct: true, optionId });
const WRONG: Action = { type: "answer.judge", correct: false };
const bad: Step = ctl(WRONG);
const END: Step[] = [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

const newGame = (game: GameDocument = DEMO_POLL_GAME): Game => createGame(makeSession(game));
const play = (steps: readonly Step[], game?: GameDocument): Game => run(reg, steps, newGame(game));
const viewOf = (g: Game, viewer: Parameters<typeof project>[1]): PollBoardMechanicView => {
  const m = pollOf(project(g, viewer, reg));
  if (m === null) throw new Error("no poll-board view");
  return m;
};
const rejection = (g: Game, action: Action) => {
  const r = decide(g, { action, actor: CONTROL, idempotencyKey: null }, 9e12, reg);
  return r.ok ? null : r.error.code;
};

function withConfig(cfg: Record<string, unknown>): GameDocument {
  const round = DEMO_POLL_GAME.format.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return { ...DEMO_POLL_GAME, format: { ...DEMO_POLL_GAME.format, rounds: [{ ...round, mechanicConfig: cfg }] } };
}

describe("poll-board scoring", () => {
  it("the team with the hand banks the values it found when the steal fails", () => {
    const g = play([...OPEN, good("a"), good("c"), bad, bad, bad, ctl({ type: "poll.steal", teamId: "t_b" }), bad, ...END]);
    expect(teamTotal(g.state, "t_a")).toBe(38 + 17);
    expect(teamTotal(g.state, "t_b")).toBe(0);
    expect(g.state.ledger.filter((e) => !e.voided)).toMatchObject([{ target: { teamId: "t_a" }, teamId: "t_a", delta: 55, reason: "auto", questionId: "q_poll_breakfast" }]);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
    expect(project(g, { role: "player", participantId: "p_3" }, reg)).toMatchObject({ myResult: "wrong" });
  });

  it("a successful steal takes the whole bank, including the stolen slot", () => {
    const g = play([...OPEN, good("a"), bad, bad, bad, ctl({ type: "poll.steal", teamId: "t_b" }), good("b"), ...END]);
    expect(teamTotal(g.state, "t_a")).toBe(0);
    expect(teamTotal(g.state, "t_b")).toBe(38 + 22);
    expect(viewOf(g, { role: "output", scene: "program" })).toMatchObject({ stage: "done", winnerTeamId: "t_b", bank: 60 });
  });

  it("finding every slot ends the play without steal", () => {
    const g = play([...OPEN, good("a"), good("b"), bad, good("c"), good("d"), good("e")]);
    expect(viewOf(g, { role: "output", scene: "program" })).toMatchObject({ stage: "done", strikes: 1, winnerTeamId: "t_a", bank: 92 });
    expect(rejection(g, WRONG)).toBe("conflict");
    const done = run(reg, END, g);
    expect(teamTotal(done.state, "t_a")).toBe(92);
  });

  it("applies the multiplier and maxStrikes from the config", () => {
    const g = play([...OPEN, good("a"), bad, ctl({ type: "poll.steal", teamId: "t_b" }), bad, ...END], withConfig({ maxStrikes: 1, multiplier: 3 }));
    expect(teamTotal(g.state, "t_a")).toBe(38 * 3);
  });

  it("locking early gives the bank to the team with the hand", () => {
    const g = play([...OPEN, good("b"), ...END]);
    expect(teamTotal(g.state, "t_a")).toBe(22);
  });

  it("slots revealed by control count for nobody", () => {
    const g = play([...OPEN, good("a"), ctl({ type: "element.reveal", index: 4 }), ...END]);
    expect(teamTotal(g.state, "t_a")).toBe(38);
    expect(viewOf(g, { role: "output", scene: "program" }).slots[4]).toEqual({ index: 4, revealed: true, found: false, optionId: "e", label: "Pamplemousse", value: 6 });
  });

  it("undoing a strike restores the play, replay included", () => {
    const g = play([...OPEN, good("a"), bad, bad, bad, ctl({ type: "undo" })]);
    expect(viewOf(g, { role: "control" })).toMatchObject({ strikes: 2, stage: "play" });
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });
});

describe("poll-board projections", () => {
  it("never shows a masked slot's label or value to players and outputs", () => {
    const g = play([...OPEN, good("c")]);
    for (const viewer of [{ role: "player", participantId: "p_3" }, { role: "output", scene: "program" }] as const) {
      const m = viewOf(g, viewer);
      expect(m.slots.map((s) => s.label)).toEqual([null, null, "Orange", null, null]);
      expect(m.slots.map((s) => s.value)).toEqual([null, null, 17, null, null]);
      const json = JSON.stringify(project(g, viewer, reg));
      for (const secret of ["Banane", "Pomme", "Kiwi", "Pamplemousse", "100 personnes"]) expect(json).not.toContain(secret);
    }
    expect(viewOf(g, { role: "host" }).slots.map((s) => s.label)).toEqual(["Banane", "Pomme", "Orange", "Kiwi", "Pamplemousse"]);
  });

  it("question.reveal does not flip the remaining slots: control flips them one by one", () => {
    const g = play([...OPEN, good("a"), ...END]);
    expect(viewOf(g, { role: "output", scene: "program" }).slots.filter((s) => s.revealed)).toHaveLength(1);
    const flipped = run(reg, [ctl({ type: "element.reveal", index: 1 })], g);
    expect(viewOf(flipped, { role: "output", scene: "program" }).slots[1]).toMatchObject({ revealed: true, label: "Pomme" });
    expect(teamTotal(flipped.state, "t_a")).toBe(38);
  });

  it("shows strikes, hand and steal to everyone", () => {
    const g = play([...OPEN, bad, bad, bad, ctl({ type: "poll.steal", teamId: "t_b" })]);
    expect(viewOf(g, { role: "player", participantId: "p_1" })).toMatchObject({ strikes: 3, maxStrikes: 3, stage: "steal", controllingTeamId: "t_a", stealingTeamId: "t_b", bank: 0, winnerTeamId: null });
  });

  it("sorts slots by value, highest first", () => {
    const q = DEMO_POLL_GAME.questions[0];
    if (q === undefined || q.answerSpec.kind !== "poll") throw new Error("fixture");
    const shuffled: Question = { ...q, answerSpec: { ...q.answerSpec, options: q.answerSpec.options.toReversed() } };
    const r = pollBoard.init({ maxStrikes: 3, multiplier: 1 }, shuffled, { at: 0, phase: "idle", rng: createRng(1, 1) }, { previous: null, questionIndex: 0, questionsLeft: 0 });
    if (!r.ok) throw new Error(r.error.message);
    expect(pollBoard.project(r.value, { audience: "host", phase: "presenting", participantId: null })).toMatchObject({ slots: [{ value: 38 }, { value: 22 }, { value: 17 }, { value: 9 }, { value: 6 }] });
  });
});

describe("poll-board rejections", () => {
  const open = play(OPEN);
  it.each<[string, Action, string]>([
    ["correct answer without slot", { type: "answer.judge", correct: true }, "invalid"],
    ["unknown slot", { type: "answer.judge", correct: true, optionId: "zz" }, "not-found"],
    ["steal before the last strike", { type: "poll.steal", teamId: "t_b" }, "conflict"],
    ["unknown team", { type: "poll.control", teamId: "t_zz" }, "not-found"],
    ["reveal out of range", { type: "element.reveal", index: 9 }, "not-found"],
    ["foreign action", { type: "joker.use", joker: "fifty" }, "unsupported"],
    ["player answer", { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } }, "unsupported"],
  ])("rejects %s", (_name, action, code) => {
    expect(rejection(open, action)).toBe(code);
  });

  it("rejects judging before the hand is given, or outside open answers", () => {
    expect(rejection(play([...PRESENTED, ctl({ type: "question.open" })]), WRONG)).toBe("conflict");
    expect(rejection(play(PRESENTED), WRONG)).toBe("wrong-phase");
  });

  it("rejects finding a slot twice and stealing with the team that has the hand", () => {
    expect(rejection(play([...OPEN, good("a")]), { type: "answer.judge", correct: true, optionId: "a" })).toBe("conflict");
    expect(rejection(play([...OPEN, bad, bad, bad]), { type: "poll.steal", teamId: "t_a" })).toBe("conflict");
    expect(rejection(play([...OPEN, bad, bad, bad]), WRONG)).toBe("conflict"); // steal team not designated
  });

  it("refuses non-poll questions and options without value", () => {
    const env = { at: 0, phase: "idle", rng: createRng(1, 1) } as const;
    const round = { previous: null, questionIndex: 0, questionsLeft: 0 };
    const oral: Question = { id: "q_o", prompt: { text: "?" }, answerSpec: { kind: "oral", expected: "x" }, hints: [], tags: [] };
    expect(pollBoard.init({ maxStrikes: 3, multiplier: 1 }, oral, env, round)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const noValue: Question = { ...oral, answerSpec: { kind: "poll", options: [{ id: "a", label: "A" }] } };
    expect(pollBoard.init({ maxStrikes: 3, multiplier: 1 }, noValue, env, round)).toMatchObject({ ok: false, error: { code: "invalid" } });
    const negative: Question = { ...oral, answerSpec: { kind: "poll", options: [{ id: "a", label: "A", value: -5 }] } };
    expect(pollBoard.init({ maxStrikes: 3, multiplier: 1 }, negative, env, round)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});

describe("review of phase 1 mechanics — poll-board", () => {
  it("#5 team totals reach every view through teamBoard", () => {
    const g = play([...OPEN, good("a"), ...END]);
    for (const viewer of [{ role: "output", scene: "program" }, { role: "player", participantId: "p_3" }] as const) {
      expect(project(g, viewer, reg).teamBoard).toEqual([
        { teamId: "t_a", name: "Les Rouges", color: "#ff0000", total: 38, rank: 1 },
        { teamId: "t_b", name: "Les Bleus", color: "#0000ff", total: 0, rank: 2 },
      ]);
    }
  });

  it("#8 the hand cannot change once play has started", () => {
    expect(rejection(play([...OPEN, good("a")]), { type: "poll.control", teamId: "t_b" })).toBe("conflict");
    expect(rejection(play([...OPEN, bad]), { type: "poll.control", teamId: "t_b" })).toBe("conflict");
    expect(rejection(play(OPEN), { type: "poll.control", teamId: "t_b" })).toBeNull();
  });
});
