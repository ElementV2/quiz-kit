import { describe, expect, it } from "vitest";
import { DEMO_GAME, multiShare, type ChoiceMechanicView, type GameDocument, type MultiScoring, type Question, type Viewer } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { GameState, participantTotal } from "../../state.ts";
import { addPlayers, answer, ctl, makeSession, run, type Step } from "../../testing/harness.ts";

/**
 * Several-answers QCM, counted four ways (category, question, live choice of the control room). `q_primes`: right
 * answers a and c among a, b, c, d. Players: p_1 ticks a (1 right of 2), p_2 a+b (1 right, 1 wrong), p_3 a+c (exact),
 * p_4 everything (2 right, 2 wrong). 100 points, no decay.
 */

const PRIMES = "q_primes";

function game(opts: { readonly mechanic?: "mixed" | "choice"; readonly config?: Record<string, unknown>; readonly questionMode?: MultiScoring } = {}): GameDocument {
  const questions = DEMO_GAME.questions.map((q): Question => (q.id === PRIMES && q.answerSpec.kind === "multi" && opts.questionMode !== undefined ? { ...q, answerSpec: { ...q.answerSpec, multiScoring: opts.questionMode } } : q));
  return {
    ...DEMO_GAME,
    questions,
    format: {
      ...DEMO_GAME.format,
      rounds: [
        { id: "r_multi", title: "Multi", mechanic: opts.mechanic ?? "mixed", mechanicConfig: opts.config ?? {}, questions: [PRIMES, "q_capital_fr"], reserve: [], scoring: [{ type: "base", points: 100 }] },
        { id: "r_again", title: "Encore", mechanic: "mixed", mechanicConfig: {}, questions: [PRIMES], reserve: [], scoring: [{ type: "base", points: 100 }] },
      ],
    },
  };
}

const START: Step[] = [...addPlayers(4), ctl({ type: "game.start" }), ctl({ type: "round.start" })];
const ANSWERS: Step[] = [answer("p_1", "a"), answer("p_2", "a", "b"), answer("p_3", "a", "c"), answer("p_4", "a", "b", "c", "d")];
const ON_AIR: Step[] = [...START, ctl({ type: "question.present" }), ...ANSWERS, ctl({ type: "question.lock" })];
const REVEAL = ctl({ type: "question.reveal" });
const setMode = (mode: MultiScoring | null, questionId = PRIMES): Step => ctl({ type: "question.setMultiScoring", questionId, mode });

const play = (steps: readonly Step[], doc: GameDocument = game()): Game => run(reg, steps, createGame(makeSession(doc)));
const points = (g: Game): number[] => ["p_1", "p_2", "p_3", "p_4"].map((p) => participantTotal(g.state, p));
const choiceOf = (g: Game, viewer: Viewer = { role: "control" }): ChoiceMechanicView => {
  const m = project(g, viewer, reg).mechanic;
  if (m?.mechanic !== "choice") throw new Error("no choice view");
  return m;
};
const attempt = (g: Game, [who, action]: Step) => decide(g, { action, actor: who, idempotencyKey: null }, 9_000_000 + g.events.length * 1000, reg);
const kindsChoice = (choice: Record<string, unknown>) => ({ kinds: { choice } });

describe("multiShare (shared by the engine and the explanations)", () => {
  it("counts each way", () => {
    // 2 right answers.
    expect([multiShare("all", 1, 0, 2), multiShare("all", 2, 0, 2), multiShare("all", 2, 1, 2)]).toEqual([0, 1, 0]);
    expect([multiShare("partial-penalty", 1, 0, 2), multiShare("partial-penalty", 1, 1, 2), multiShare("partial-penalty", 2, 1, 2)]).toEqual([0.5, 0, 0.5]);
    expect([multiShare("partial", 1, 0, 2), multiShare("partial", 1, 1, 2), multiShare("partial", 2, 1, 2), multiShare("partial", 2, 2, 2)]).toEqual([0.5, 0.5, 0, 0]);
    expect([multiShare("any-no-wrong", 1, 0, 2), multiShare("any-no-wrong", 1, 1, 2), multiShare("any-no-wrong", 0, 0, 2)]).toEqual([1, 0, 0]);
  });
});

describe("several-answers QCM: the four ways of counting", () => {
  it.each([
    ["all", [0, 0, 100, 0]],
    ["partial-penalty", [50, 0, 100, 0]],
    ["partial", [50, 50, 100, 0]], // ticking everything (4 boxes for 2 right answers) scores nothing
    ["any-no-wrong", [100, 0, 100, 0]],
  ] as const)("category setting %s", (mode, expected) => {
    expect(points(play([...ON_AIR, REVEAL], game({ config: kindsChoice({ multiScoring: mode }) })))).toEqual(expected);
  });

  it("all or nothing by default", () => {
    expect(points(play([...ON_AIR, REVEAL]))).toEqual([0, 0, 100, 0]);
    expect(choiceOf(play(ON_AIR)).multiScoring).toEqual({ mode: "all", from: "category" });
  });

  it("a partial result says « en partie juste » on the tablet, a whole one « juste »", () => {
    const g = play([...ON_AIR, REVEAL], game({ config: kindsChoice({ multiScoring: "partial" }) }));
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "partial" });
    expect(project(g, { role: "player", participantId: "p_3" }, reg)).toMatchObject({ myResult: "correct" });
    expect(project(g, { role: "player", participantId: "p_4" }, reg)).toMatchObject({ myResult: "wrong" });
    const any = play([...ON_AIR, REVEAL], game({ config: kindsChoice({ multiScoring: "any-no-wrong" }) }));
    expect(project(any, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
  });

  it("only several-answers QCM carry a way of counting", () => {
    const doc = game();
    const [first] = doc.format.rounds;
    if (first === undefined) throw new Error("round");
    const g = play([...START, ctl({ type: "question.present" })], { ...doc, format: { ...doc.format, rounds: [{ ...first, id: "r_single", questions: ["q_capital_fr"] }] } });
    expect(choiceOf(g).multiScoring).toBeNull();
    expect(attempt(g, setMode("partial", "q_capital_fr"))).toMatchObject({ ok: false, error: { message: expect.stringMatching(/plusieurs réponses/) } });
  });
});

describe("priority: live choice > question > category > all", () => {
  it("the question's own setting wins over the category", () => {
    const g = play([...ON_AIR, REVEAL], game({ config: kindsChoice({ multiScoring: "partial" }), questionMode: "any-no-wrong" }));
    expect(points(g)).toEqual([100, 0, 100, 0]);
    expect(choiceOf(g).multiScoring).toEqual({ mode: "any-no-wrong", from: "question" });
  });

  it("the control room's choice wins, and null goes back to the question's", () => {
    const doc = game({ config: kindsChoice({ multiScoring: "partial" }), questionMode: "any-no-wrong" });
    const live = play([...ON_AIR, setMode("all")], doc);
    expect(choiceOf(live).multiScoring).toEqual({ mode: "all", from: "control" });
    const back = run(reg, [setMode(null), REVEAL], live);
    expect(choiceOf(back).multiScoring).toEqual({ mode: "any-no-wrong", from: "question" });
    expect(points(back)).toEqual([100, 0, 100, 0]);
  });

  it("refuses setting the same way twice (a double press changes nothing)", () => {
    const g = play([...ON_AIR, setMode("partial")]);
    expect(attempt(g, setMode("partial")).ok).toBe(false);
    expect(attempt(play(ON_AIR), setMode(null)).ok).toBe(false); // nothing chosen yet
  });

  it("chosen ahead of the question: applies when it is presented (and to every use of the question)", () => {
    const g = play([...START, setMode("partial"), ctl({ type: "question.present" }), ...ANSWERS, ctl({ type: "question.lock" }), REVEAL]);
    expect(points(g)).toEqual([50, 50, 100, 0]);
    expect(choiceOf(g).multiScoring).toEqual({ mode: "partial", from: "control" });
  });
});

describe("changing the way of counting live", () => {
  it("before the reveal: the reveal scores with the new way", () => {
    expect(points(play([...ON_AIR, setMode("partial-penalty"), REVEAL]))).toEqual([50, 0, 100, 0]);
  });

  it("after the reveal: the points are rewritten at once (reason regrade), the tablets follow", () => {
    const g = play([...ON_AIR, REVEAL]);
    expect(points(g)).toEqual([0, 0, 100, 0]);
    const after = run(reg, [setMode("partial")], g);
    expect(points(after)).toEqual([50, 50, 100, 0]);
    expect(after.state.ledger.filter((e) => !e.voided).every((e) => e.reason === "regrade")).toBe(true);
    expect(project(after, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myResult: "partial" });
    // Between questions too (the question was left).
    const later = run(reg, [ctl({ type: "question.next" }), setMode("any-no-wrong")], after);
    expect(points(later)).toEqual([100, 0, 100, 0]);
  });

  it("a verdict forced by the control room keeps priority over any way of counting", () => {
    const g = play([...ON_AIR, REVEAL, ctl({ type: "answer.verdict", roundIndex: 0, questionIndex: 0, participantId: "p_1", correct: false }), setMode("any-no-wrong")]);
    expect(points(g)).toEqual([0, 0, 100, 0]);
  });

  it("rescores every reveal of the question (each round where it was played), only the auto lines", () => {
    let g = play([...ON_AIR, REVEAL, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 7, reason: "manual" })]);
    g = run(reg, [ctl({ type: "question.next" }), ctl({ type: "round.start", roundIndex: 1 }), ctl({ type: "question.present" }), ...ANSWERS, ctl({ type: "question.lock" }), REVEAL], g);
    expect(points(g)).toEqual([7, 0, 200, 0]);
    expect(points(run(reg, [setMode("partial")], g))).toEqual([107, 100, 200, 0]);
  });

  it("undo puts the points back; replay and a snapshot read back from disk agree", () => {
    const g = play([...ON_AIR, REVEAL, setMode("partial")]);
    const u = run(reg, [ctl({ type: "undo" })], g);
    expect(points(u)).toEqual([0, 0, 100, 0]);
    expect(choiceOf(u).multiScoring?.from).toBe("category");
    expect(replay(u.session, u.events, reg).state).toEqual(u.state);
    const mid = g.events.length - 1;
    const snap = GameState.parse(JSON.parse(JSON.stringify(replay(g.session, g.events.slice(0, mid), reg).state)));
    expect(replay(g.session, g.events, reg, { seq: mid, state: snap }).state).toEqual(g.state);
  });

  it("a regrade keeps the way chosen live", () => {
    const g = play([...ON_AIR, REVEAL, setMode("partial")]);
    const q = g.state.game.questions.find((x) => x.id === PRIMES);
    if (q?.answerSpec.kind !== "multi") throw new Error("multi");
    const r = run(reg, [ctl({ type: "question.regrade", questionId: PRIMES, answerSpec: { ...q.answerSpec, correct: ["a", "b"] } })], g);
    expect(points(r)).toEqual([50, 100, 50, 0]); // a+b right now: p_1 1/2, p_2 exact, p_3 1/2, p_4 too many ticks
  });
});

describe("older documents, journals and snapshots (partialMulti)", () => {
  it("a choice round with partialMulti true counts « erreurs déduites », false all or nothing", () => {
    expect(points(play([...ON_AIR, REVEAL], game({ mechanic: "choice", config: { partialMulti: true } })))).toEqual([50, 0, 100, 0]);
    expect(points(play([...ON_AIR, REVEAL], game({ mechanic: "choice", config: { partialMulti: false } })))).toEqual([0, 0, 100, 0]);
  });

  it("a « Mixte » round with kinds.choice.partialMulti true counts « erreurs déduites »", () => {
    const g = play([...ON_AIR, REVEAL], game({ config: kindsChoice({ partialMulti: true }) }));
    expect(points(g)).toEqual([50, 0, 100, 0]);
    expect(choiceOf(g).multiScoring).toEqual({ mode: "partial-penalty", from: "category" });
  });

  it("a mechanic state saved before (partialMulti only) is still judged the same", () => {
    const g = play(ON_AIR, game({ mechanic: "choice", config: { partialMulti: true } }));
    const raw: unknown = JSON.parse(JSON.stringify(g.state));
    // The state as an older version wrote it: no multiScoring field.
    const strip = (x: unknown): unknown => (Array.isArray(x) ? x.map(strip) : typeof x === "object" && x !== null ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "multiScoring" && k !== "multiFrom" && k !== "multiLive").map(([k, v]) => [k, strip(v)])) : x);
    const old = GameState.parse(strip(raw));
    const resumed = run(reg, [REVEAL], { ...g, state: old });
    expect(points(resumed)).toEqual([50, 0, 100, 0]);
  });
});
