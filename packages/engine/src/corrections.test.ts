import { describe, expect, it } from "vitest";
import { DEMO_BUZZER_GAME, DEMO_EVENING_GAME, DEMO_GAME, DEMO_LADDER_GAME, DEMO_TEXT_GAME, type Action, type GameDocument } from "@quiz/schema";
import { createGame, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { leaderboard, project } from "./project.ts";
import { GameState, participantTotal, teamTotal } from "./state.ts";
import { matchesText } from "./mechanics/shared/text-match.ts";
import { actor, addPlayers, answer, ctl, makeSession, run } from "./testing/harness.ts";

const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;
const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3)];
const REVEAL = [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

const game = () => createGame(makeSession(DEMO_EVENING_GAME));
const twoQuestions = (tieBreak: "speed" | "control"): GameDocument => ({ ...DEMO_TEXT_GAME, format: { ...DEMO_TEXT_GAME.format, tieBreak, rounds: DEMO_TEXT_GAME.format.rounds.map((r) => ({ ...r, scoring: [{ type: "base", points: 100 }], timer: undefined })) } });
const twoRounds = (): GameDocument => ({
    ...DEMO_TEXT_GAME,
    format: { ...DEMO_TEXT_GAME.format, rounds: [0, 1].map((i) => ({ ...DEMO_TEXT_GAME.format.rounds[0]!, id: `r_${i}`, questions: ["q_txt_1"], timer: undefined, scoring: [{ type: "base", points: 100 }] })) }, // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
  });
const regradeTo = (accepted: string[]) => ctl({ type: "question.regrade", questionId: "q_txt_1", answerSpec: { kind: "text", accepted } });
const playQ = (text: string) => [ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_1", text), ...REVEAL, ctl({ type: "question.next" })];

describe("question.replaceFromReserve", () => {

  it("replaces the question on air, from scratch (answers to the old one are dropped)", () => {
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_1", "Van Gogh")], game());
    g = run(reg, [ctl({ type: "question.replaceFromReserve", reserveId: "q_txt_3" })], g);
    expect(g.state.phase).toBe("presenting");
    expect(project(g, { role: "output", scene: "program" }, reg).question).toMatchObject({ id: "q_txt_3", index: 0 });
    expect(project(g, { role: "control" }, reg)).toMatchObject({ answers: [] });
    expect(g.state.game.format.rounds[0]).toMatchObject({ questions: ["q_txt_3", "q_txt_2"], reserve: [] });
    // Once used, it is no longer in the reserve.
    expect(() => run(reg, [ctl({ type: "question.replaceFromReserve", reserveId: "q_txt_3" })], g)).toThrow(/réserve/);
  });

  it("replaces the next question between questions, refuses after the reveal, and undo restores", () => {
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), ...REVEAL], game());
    expect(() => run(reg, [ctl({ type: "question.replaceFromReserve", reserveId: "q_txt_3" })], g)).toThrow(/wrong-phase/);
    g = run(reg, [ctl({ type: "question.next" }), ctl({ type: "question.replaceFromReserve", reserveId: "q_txt_3" })], g);
    expect(g.state.game.format.rounds[0]?.questions).toEqual(["q_txt_1", "q_txt_3"]);
    g = run(reg, [ctl({ type: "undo" })], g);
    expect(g.state.game.format.rounds[0]?.questions).toEqual(["q_txt_1", "q_txt_2"]);
  });
});

describe("question.edit", () => {
  it("fixes the text of the question on air only", () => {
    const g0 = createGame(makeSession(DEMO_GAME));
    expect(() => run(reg, [...START, ctl({ type: "question.edit", text: "x" })], g0)).toThrow(/wrong-phase/);
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.edit", text: "Quelle est la capitale de la République française ?" })], g0);
    expect(project(g, { role: "player", participantId: "p_1" }, reg).question?.prompt.text).toBe("Quelle est la capitale de la République française ?");
  });
});

describe("question.regrade", () => {
  it("re-judges every answer of a past question and rewrites its points (manual points stay)", () => {
    const g0 = createGame(makeSession(DEMO_GAME));
    // q_capital_fr: right = b. p_1 says b, p_2 says a.
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", "b"), answer("p_2", "a"), ...REVEAL, ctl({ type: "score.adjust", target: { participantId: "p_2" }, delta: 7, reason: "manual" }), ctl({ type: "question.next" })], g0);
    const p1 = participantTotal(g.state, "p_1");
    expect(p1).toBeGreaterThan(0);
    expect(participantTotal(g.state, "p_2")).toBe(7);
    const spec = DEMO_GAME.questions[0]?.answerSpec;
    if (spec?.kind !== "single") throw new Error("fixture");
    g = run(reg, [ctl({ type: "question.regrade", questionId: "q_capital_fr", answerSpec: { ...spec, correct: "a" } })], g);
    expect(participantTotal(g.state, "p_1")).toBe(0);
    expect(participantTotal(g.state, "p_2")).toBeGreaterThan(7); // timeDecay: p_2 answered later than p_1
    expect(g.state.ledger.filter((e) => !e.voided && e.reason === "regrade")).toHaveLength(1);
    // Regrading back restores the first result; replay gives the same state.
    g = run(reg, [ctl({ type: "question.regrade", questionId: "q_capital_fr", answerSpec: spec })], g);
    expect(participantTotal(g.state, "p_1")).toBe(p1);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
    // Undo the last regrade: back to "a".
    g = run(reg, [ctl({ type: "undo" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(0);
  });

  it("refuses another answer kind, an unplayed question and human-judged mechanics", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", "b"), ...REVEAL], createGame(makeSession(DEMO_GAME)));
    expect(() => run(reg, [ctl({ type: "question.regrade", questionId: "q_capital_fr", answerSpec: { kind: "boolean", correct: true } })], g)).toThrow(/invalid/);
    expect(() => run(reg, [ctl({ type: "question.regrade", questionId: "q_bool", answerSpec: { kind: "boolean", correct: true } })], g)).toThrow(/conflict|not-found/);
    const buzz = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), ...REVEAL], createGame(makeSession(DEMO_BUZZER_GAME)));
    const q = DEMO_BUZZER_GAME.questions[0];
    if (q === undefined) throw new Error("fixture");
    expect(() => run(reg, [ctl({ type: "question.regrade", questionId: q.id, answerSpec: q.answerSpec })], buzz)).toThrow(/unsupported/);
  });

  it("is allowed to the scorer, never to a player", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_1", "Monet"), ...REVEAL], createGame(makeSession(DEMO_TEXT_GAME)));
    const regrade: Action = { type: "question.regrade", questionId: "q_txt_1", answerSpec: { kind: "text", accepted: ["Claude Monet", "Monet"] } };
    expect(() => run(reg, [[actor("player", "p_1"), regrade]], g)).toThrow(/forbidden/);
    const after = run(reg, [[actor("scorer", "s"), regrade]], g);
    expect(participantTotal(after.state, "p_1")).toBeGreaterThan(0);
    expect(project(after, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
  });
});

describe("tie-break", () => {

  it("speed: equal totals are split by cumulated answer time; control: same rank", () => {
    const steps = [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_2", "Van Gogh"), say("p_1", "Van Gogh"), ...REVEAL];
    const speed = run(reg, steps, createGame(makeSession(twoQuestions("speed"))));
    expect(leaderboard(speed.state).map((r) => [r.participantId, r.rank])).toEqual([["p_2", 1], ["p_1", 2], ["p_3", 3]]);
    const control = run(reg, steps, createGame(makeSession(twoQuestions("control"))));
    expect(leaderboard(control.state).map((r) => [r.participantId, r.rank])).toEqual([["p_1", 1], ["p_2", 1], ["p_3", 3]]);
  });
});

describe("review 2 regressions", () => {

  it("B1: a regrade of round 0 survives the same question revealed again in round 1", () => {
    let g = run(reg, [...START, ...playQ("Monet"), regradeTo(["Monet"])], createGame(makeSession(twoRounds())));
    expect(participantTotal(g.state, "p_1")).toBe(100);
    g = run(reg, [ctl({ type: "round.start" }), ...playQ("Monet")], g);
    expect(participantTotal(g.state, "p_1")).toBe(200);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });

  it("I1: a regrade credits the team of the original scoring", () => {
    let g = run(reg, [ctl({ type: "team.add", teamId: "t_a", name: "A", color: "#111111" }), ctl({ type: "team.add", teamId: "t_b", name: "B", color: "#222222" }), ...START, ctl({ type: "player.setTeam", participantId: "p_1", teamId: "t_a" }), ...playQ("Van Gogh")], createGame(makeSession(DEMO_TEXT_GAME)));
    const a = teamTotal(g.state, "t_a");
    expect(a).toBeGreaterThan(0);
    g = run(reg, [ctl({ type: "player.setTeam", participantId: "p_1", teamId: "t_b" }), regradeTo(["Vincent van Gogh", "Van Gogh", "Gogh"])], g);
    expect([teamTotal(g.state, "t_a"), teamTotal(g.state, "t_b")]).toEqual([a, 0]);
  });

  it("I2: refuses to replace a question already revealed", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), ...REVEAL, ctl({ type: "question.next" })], createGame(makeSession(DEMO_EVENING_GAME)));
    expect(() => run(reg, [ctl({ type: "question.replaceFromReserve", reserveId: "q_txt_3", questionIndex: 0 })], g)).toThrow(/déjà été révélée/);
  });

  it("I3: a choice regrade must target shown options", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", "b"), ...REVEAL], createGame(makeSession(DEMO_GAME)));
    const spec = DEMO_GAME.questions[0]?.answerSpec;
    if (spec?.kind !== "single") throw new Error("fixture");
    expect(() => run(reg, [ctl({ type: "question.regrade", questionId: "q_capital_fr", answerSpec: { ...spec, options: spec.options.map((o) => ({ ...o, id: `${o.id}2` })), correct: "b2" } })], g)).toThrow(/invalid/);
  });

  it("speed tie-break: more right answers first, then the faster", () => {
    const g0 = createGame(makeSession({ ...DEMO_TEXT_GAME, format: { ...DEMO_TEXT_GAME.format, tieBreak: "speed", rounds: DEMO_TEXT_GAME.format.rounds.map((r) => ({ ...r, timer: undefined, scoring: [{ type: "base", points: 100 }] })) } }));
    // Q1: p_1 right (fast). Q2: p_2 right. Q3: p_2 right, p_1 gets +100 manual → 200 / 200, p_2 has 2 right answers.
    const g = run(reg, [...START, ...playQ("Van Gogh"), ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_2", "Canberra"), ...REVEAL, ctl({ type: "question.next" }), ctl({ type: "question.present" }), ctl({ type: "question.open" }), say("p_2", "1789"), ...REVEAL, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 100, reason: "bonus" })], g0);
    expect(leaderboard(g.state).slice(0, 2).map((r) => [r.participantId, r.total, r.rank])).toEqual([["p_2", 200, 1], ["p_1", 200, 2]]);
  });

  it("m1: non-Latin answers are compared, not erased", () => {
    expect(matchesText("Москва", { accepted: ["москва"] })).toBe(true);
    expect(matchesText("Рим", { accepted: ["Москва"], maxDistance: 3 })).toBe(false);
    expect(matchesText("Straße", { accepted: ["strasse"] })).toBe(true);
  });

  it("snapshots carrying history round-trip", () => {
    const g = run(reg, [...START, ...playQ("Van Gogh")], createGame(makeSession(DEMO_TEXT_GAME)));
    expect(GameState.parse(JSON.parse(JSON.stringify(g.state)))).toEqual(g.state);
  });
});

describe("host drives (host.setDrive)", () => {
  const host = actor("host", "h");
  it("the host reads every question ahead; drives the flow only once allowed, never scores or undo", () => {
    let g = run(reg, [...START], createGame(makeSession(DEMO_GAME)));
    const v = project(g, { role: "host" }, reg);
    if (v.role !== "host") throw new Error("host view");
    expect(v.drive).toBe(false);
    expect(v.rundown[0]?.questions[0]).toMatchObject({ text: expect.any(String), answerSpec: { kind: "single" }, notes: expect.any(String) });
    expect(() => run(reg, [[host, { type: "question.present" }]], g)).toThrow(/forbidden/);
    g = run(reg, [ctl({ type: "host.setDrive", enabled: true }), [host, { type: "question.present", questionIndex: 1 }], [host, { type: "question.open" }]], g);
    expect(g.state.phase).toBe("open");
    expect(() => run(reg, [[host, { type: "score.adjust", target: { participantId: "p_1" }, delta: 5, reason: "manual" }]], g)).toThrow(/forbidden/);
    expect(() => run(reg, [[host, { type: "undo" }]], g)).toThrow(/forbidden/);
    expect(() => run(reg, [[host, { type: "host.setDrive", enabled: false }]], g)).toThrow(/forbidden/);
    g = run(reg, [ctl({ type: "host.setDrive", enabled: false })], g);
    expect(() => run(reg, [[host, { type: "question.lock" }]], g)).toThrow(/forbidden/);
    expect(project(g, { role: "control" }, reg)).toMatchObject({ hostDrives: false });
  });
});

describe("review 3 regressions", () => {
  it("B1: host.setDrive is never undone — what the host drove stays", () => {
    const host = actor("host", "h");
    let g = run(reg, [...START, ctl({ type: "host.setDrive", enabled: true }), [host, { type: "question.present" }], [host, { type: "question.open" }], answer("p_1", "b"), [host, { type: "question.lock" }], [host, { type: "question.reveal" }]], createGame(makeSession(DEMO_GAME)));
    const total = participantTotal(g.state, "p_1");
    expect(total).toBeGreaterThan(0);
    const setDrive = g.events.find((e) => e.action.type === "host.setDrive");
    expect(() => run(reg, [ctl({ type: "undo", targetSeq: setDrive?.seq ?? 0 })], g)).toThrow(/forbidden/);
    // A bare undo skips it and cancels the reveal instead (the last undoable control action).
    g = run(reg, [ctl({ type: "host.setDrive", enabled: false }), ctl({ type: "undo" })], g);
    expect(g.state.hostDrives).toBe(false);
    expect(g.skipped).toEqual([]);
  });

  it("m3: the reveal history keeps crowd-vote counts, not every viewer", () => {
    const chatGame = { ...DEMO_LADDER_GAME, format: { ...DEMO_LADDER_GAME.format, rounds: [{ ...DEMO_LADDER_GAME.format.rounds[0]!, mechanic: "crowd-vote", mechanicConfig: {}, timer: undefined }] } }; // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
    const votes = Array.from({ length: 50 }, (_, i) => ({ userId: `tw:${i}`, optionId: i % 3 === 0 ? "a" : "b" }));
    const g = run(reg, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "question.present" }), ctl({ type: "question.open" }), [actor("system"), { type: "crowd.tally", votes }], ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(chatGame)));
    const rec = g.state.history[0]?.state;
    expect(rec).toMatchObject({ votes: [], frozen: { counts: { a: 17, b: 33 }, voters: 50 } });
  });
});

