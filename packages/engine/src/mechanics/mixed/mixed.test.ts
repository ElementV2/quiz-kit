import { describe, expect, it } from "vitest";
import { DEMO_BUZZER_GAME, DEMO_EVENING_GAME, DEMO_GAME, DEMO_LADDER_GAME, DEMO_POLL_GAME, GameDocument, type Question } from "@quiz/schema";
import { createGame, replay } from "../../game.ts";
import { MIXED_ROUTES, defaultRegistry as reg, pointsInfo } from "../../index.ts";
import { project } from "../../project.ts";
import { actor, addPlayers, answer, ctl, makeSession, run, type Step } from "../../testing/harness.ts";

const pick = (id: string): Question => {
  const q = [DEMO_GAME, DEMO_POLL_GAME, DEMO_BUZZER_GAME, DEMO_EVENING_GAME].flatMap((g) => g.questions).find((x) => x.id === id);
  if (q === undefined) throw new Error(`fixture ${id}`);
  return q;
};
const IDS = ["q_capital_fr", "q_poll_breakfast", "q_buzz_everest", "q_txt_1", "q_num_1", "q_ord_1"];
const MIXED: GameDocument = GameDocument.parse({
  ...DEMO_GAME,
  questions: IDS.map(pick),
  format: { ...DEMO_GAME.format, rounds: [{ ...DEMO_GAME.format.rounds[0], id: "r_mix", title: "Manche mixte", mechanic: "mixed", mechanicConfig: {}, questions: IDS, reserve: [] }] },
});
const START: Step[] = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2)];
const NEXT = ctl({ type: "question.next" });
const text = (pid: string, t: string): Step => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text: t } }];

describe("mixed round (ADR-0015): every question kind in one round", () => {
  it("each question is played by the mechanic of its kind", () => {
    let g = run(reg, START, createGame(makeSession(MIXED)));
    const seen: string[] = [];
    for (let i = 0; i < IDS.length; i++) {
      g = run(reg, [ctl({ type: "question.present" })], g);
      seen.push(g.state.mechanic?.id ?? "?");
      const v = project(g, { role: "output", scene: "program" }, reg);
      expect(v.mechanic?.mechanic).toBe(g.state.mechanic?.id); // views see the real mechanic
      g = run(reg, [NEXT], g);
    }
    expect(seen).toEqual(["choice", "poll-board", "buzzer", "text-answer", "number-answer", "order"]);
    expect(["round.end", "game.end"]).toContain(g.state.phase);
  });

  it("scores a QCM then a free text with the round's rule; replay identical", () => {
    const qcm = pick("q_capital_fr");
    if (qcm.answerSpec.kind !== "single") throw new Error("fixture");
    const g = run(reg, [
      ...START,
      ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", qcm.answerSpec.correct), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), NEXT,
    ], createGame(makeSession(MIXED)));
    const afterQcm = g.state.ledger.filter((e) => !e.voided).reduce((t, e) => t + e.delta, 0);
    expect(afterQcm).toBeGreaterThan(0);
    const t = run(reg, [
      ctl({ type: "question.skip", roundIndex: 0, questionIndex: 1 }), ctl({ type: "question.skip", roundIndex: 0, questionIndex: 2 }),
      ctl({ type: "question.present" }), ctl({ type: "question.open" }), text("p_2", "van gogh"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }),
    ], g);
    expect(t.state.mechanic?.id).toBe("text-answer");
    expect(t.state.ledger.some((e) => !e.voided && "participantId" in e.target && e.target.participantId === "p_2" && e.delta > 0)).toBe(true);
    expect(replay(t.session, t.events, reg).state).toEqual(t.state);
  });

  it("stakes on a poll question offer the multiplier only (its own points)", () => {
    const g = run(reg, [...START, ctl({ type: "question.skip", roundIndex: 0, questionIndex: 0 })], createGame(makeSession(MIXED)));
    expect(project(g, { role: "control" }, reg).stakesTarget).toMatchObject({ questionIndex: 1, points: false });
    expect(() => run(reg, [ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 1, points: 500, multiplier: null })], g)).toThrow(/multiplicateur/);
  });
});

const total = (g: ReturnType<typeof run>, pid: string) => g.state.ledger.filter((e) => !e.voided && "participantId" in e.target && e.target.participantId === pid).reduce((t, e) => t + e.delta, 0);

describe("mixed round — what must not break live", () => {
  const qcm = pick("q_capital_fr");
  const correct = qcm.answerSpec.kind === "single" ? qcm.answerSpec.correct : "";
  const REVEALED: Step[] = [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", correct), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

  it("a routed QCM is regraded like any QCM (its own mechanic, from the history)", () => {
    const g = run(reg, REVEALED, createGame(makeSession(MIXED)));
    expect(total(g, "p_1")).toBeGreaterThan(0);
    if (qcm.answerSpec.kind !== "single") throw new Error("fixture");
    const wrong = qcm.answerSpec.options.find((o) => o.id !== correct)?.id ?? "";
    const r = run(reg, [ctl({ type: "question.regrade", questionId: qcm.id, answerSpec: { ...qcm.answerSpec, correct: wrong } })], g);
    expect(total(r, "p_1")).toBe(0);
    expect(replay(r.session, r.events, reg).state).toEqual(r.state);
  });

  it("game.patch: settings frozen after the first question; an upcoming question may change kind and is routed again", () => {
    const g = run(reg, [...REVEALED, NEXT], createGame(makeSession(MIXED)));
    const cfg = structuredClone(g.state.game);
    const r0 = cfg.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { allowChange: false };
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: g.state.gameVersion, game: cfg })], g)).toThrow(/réglages/);
    // The next question (a survey) becomes a free text: played by text-answer at present.
    const kind = structuredClone(g.state.game);
    const poll = kind.questions.find((q) => q.id === "q_poll_breakfast");
    if (poll === undefined) throw new Error("fixture");
    poll.answerSpec = { kind: "text", accepted: ["café"] };
    const p = run(reg, [ctl({ type: "game.patch", baseVersion: g.state.gameVersion, game: kind }), ctl({ type: "question.present" })], g);
    expect(p.state.mechanic?.id).toBe("text-answer");
  });

  it("resuming from a snapshot taken mid-round gives the same game (other kind on air)", () => {
    const g = run(reg, [...REVEALED, NEXT, ctl({ type: "question.present" }), ctl({ type: "question.open" })], createGame(makeSession(MIXED)));
    const cut = g.events.findIndex((e) => e.action.type === "question.reveal");
    const prefix = replay(g.session, g.events.slice(0, cut + 1), reg);
    expect(replay(g.session, g.events, reg, { seq: prefix.state.lastSeq, state: prefix.state }).state).toEqual(g.state);
    expect(g.state.mechanic?.id).toBe("poll-board");
  });

  it("never routes to a mechanic that hides the question media or spans the round", () => {
    const bad = [...new Set(Object.values(MIXED_ROUTES))].filter((id) => {
      const m = reg.get(id);
      return m === null || m.hidesPromptMedia === true || m.freeOrder === true || m.route !== undefined;
    });
    expect(bad).toEqual([]);
  });
});

describe("mixed round — settings and points rule by category", () => {
  it("a category with its own points rule scores with it; the others with the round's", () => {
    const doc = structuredClone(MIXED);
    const r0 = doc.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { kinds: { text: { scoring: [{ type: "base", points: 500 }] }, choice: { allowChange: false } } };
    const qcm = pick("q_capital_fr");
    const correct = qcm.answerSpec.kind === "single" ? qcm.answerSpec.correct : "";
    let g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", correct), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), NEXT], createGame(makeSession(GameDocument.parse(doc))));
    const qcmPoints = total(g, "p_1");
    expect(qcmPoints).toBeGreaterThan(0);
    expect(qcmPoints).not.toBe(500);
    g = run(reg, [ctl({ type: "question.skip", roundIndex: 0, questionIndex: 1 }), ctl({ type: "question.skip", roundIndex: 0, questionIndex: 2 }), ctl({ type: "question.present" }), ctl({ type: "question.open" }), text("p_2", "van gogh"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(total(g, "p_2")).toBe(500);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
    // A verdict correction then a regrade of that text question still score with the category's rule.
    const forced = run(reg, [ctl({ type: "answer.verdict", roundIndex: 0, questionIndex: 3, participantId: "p_1", correct: true })], g);
    expect(total(forced, "p_1") - qcmPoints).toBe(500);
  });
});

describe("survey in a game played individually", () => {
  it("the hand goes to a player; the answers found score for that player (bank or per answer)", () => {
    for (const mode of ["bank", "per-answer"] as const) {
      const doc = structuredClone(MIXED);
      const r0 = doc.format.rounds[0];
      if (r0 === undefined) throw new Error("fixture");
      r0.mechanicConfig = { kinds: { poll: { mode } } };
      const poll = pick("q_poll_breakfast");
      const top = poll.answerSpec.kind === "poll" ? (poll.answerSpec.options[0]?.id ?? "") : "";
      const g = run(reg, [
        ...START,
        ctl({ type: "question.skip", roundIndex: 0, questionIndex: 0 }),
        ctl({ type: "question.present" }),
        ctl({ type: "poll.control", participantId: "p_2" }),
        ctl({ type: "question.open" }),
        ctl({ type: "answer.judge", correct: true, optionId: top }),
        ctl({ type: "question.lock" }),
        ctl({ type: "question.reveal" }),
      ], createGame(makeSession(GameDocument.parse(doc))));
      expect(g.state.mechanic?.id).toBe("poll-board");
      expect(total(g, "p_2")).toBeGreaterThan(0);
      expect(total(g, "p_1")).toBe(0);
    }
  });

  it("refuses a hand given to nobody, or to both a team and a player", () => {
    const g = run(reg, [...START, ctl({ type: "question.skip", roundIndex: 0, questionIndex: 0 }), ctl({ type: "question.present" })], createGame(makeSession(MIXED)));
    expect(() => run(reg, [ctl({ type: "poll.control" })], g)).toThrow(/équipe ou un joueur/);
    expect(() => run(reg, [ctl({ type: "poll.control", participantId: "p_9" })], g)).toThrow(/joueur inconnu/);
    expect(() => run(reg, [ctl({ type: "poll.control", participantId: "p_1", teamId: "t_x" })], g)).toThrow(/équipe ou un joueur/);
  });
});

describe("survey played individually — steal, removal", () => {
  const poll = pick("q_poll_breakfast");
  const ids = poll.answerSpec.kind === "poll" ? poll.answerSpec.options.map((o) => o.id) : [];
  const PRESENTED: Step[] = [...START, ctl({ type: "question.skip", roundIndex: 0, questionIndex: 0 }), ctl({ type: "question.present" })];
  it("bank rule: a player steals after the strikes and takes the bank; the other player gets « wrong »", () => {
    const g = run(reg, [
      ...PRESENTED,
      ctl({ type: "poll.control", participantId: "p_1" }), ctl({ type: "question.open" }),
      ctl({ type: "answer.judge", correct: true, optionId: ids[0] ?? "" }),
      ctl({ type: "answer.judge", correct: false }), ctl({ type: "answer.judge", correct: false }), ctl({ type: "answer.judge", correct: false }),
      ctl({ type: "poll.steal", participantId: "p_2" }),
      ctl({ type: "answer.judge", correct: true, optionId: ids[1] ?? "" }),
      ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }),
    ], createGame(makeSession(MIXED)));
    expect(total(g, "p_2")).toBeGreaterThan(0);
    expect(total(g, "p_1")).toBe(0);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "wrong" });
  });

  it("a removed player holding the hand keeps nothing: back to « give the hand »", () => {
    const g = run(reg, [...PRESENTED, ctl({ type: "poll.control", participantId: "p_1" }), ctl({ type: "question.open" }), ctl({ type: "answer.judge", correct: true, optionId: ids[0] ?? "" }), ctl({ type: "player.remove", participantId: "p_1" })], createGame(makeSession(MIXED)));
    const v = project(g, { role: "control" }, reg);
    expect(v.mechanic).toMatchObject({ controllingTeamId: null, stage: "play", strikes: 0 });
    expect(v.mechanic?.mechanic === "poll-board" && v.mechanic.slots.every((x) => x.foundBy === null)).toBe(true);
  });
});

describe("points of one question win over its category and the round", () => {
  it("a QCM with its own fixed points scores them; the next QCM follows the barème", () => {
    const doc = structuredClone(MIXED);
    const r0 = doc.format.rounds[0];
    const q0 = doc.questions.find((q) => q.id === "q_capital_fr");
    if (r0 === undefined || q0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { kinds: { choice: { scoring: [{ type: "base", points: 300 }] } } };
    q0.scoring = [{ type: "base", points: 1000 }];
    const correct = q0.answerSpec.kind === "single" ? q0.answerSpec.correct : "";
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", correct), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(GameDocument.parse(doc))));
    expect(total(g, "p_1")).toBe(1000);
    // live stakes still apply on top (×2)
    const staked = run(reg, [...START, ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 }), ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", correct), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(GameDocument.parse(doc))));
    expect(total(staked, "p_1")).toBe(2000);
  });

  it("a regrade or a verdict correction keeps the question's points; a live edit may not change them once played", () => {
    const doc = structuredClone(MIXED);
    const q0 = doc.questions.find((q) => q.id === "q_capital_fr");
    if (q0 === undefined || q0.answerSpec.kind !== "single") throw new Error("fixture");
    q0.scoring = [{ type: "base", points: 1000 }];
    const correct = q0.answerSpec.correct;
    const wrong = q0.answerSpec.options.find((o) => o.id !== correct)?.id ?? "";
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", wrong), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(GameDocument.parse(doc))));
    expect(total(g, "p_1")).toBe(0);
    const re = run(reg, [ctl({ type: "question.regrade", questionId: q0.id, answerSpec: { ...q0.answerSpec, correct: wrong } })], g);
    expect(total(re, "p_1")).toBe(1000);
    const forced = run(reg, [ctl({ type: "answer.verdict", roundIndex: 0, questionIndex: 0, participantId: "p_2", correct: true })], g);
    expect(total(forced, "p_2")).toBe(1000);
    const patched = structuredClone(g.state.game);
    const pq = patched.questions.find((q) => q.id === q0.id);
    if (pq !== undefined) pq.scoring = [{ type: "base", points: 5 }];
    expect(() => run(reg, [ctl({ type: "game.patch", baseVersion: g.state.gameVersion, game: patched })], g)).toThrow(/question jouée/);
  });
});

const routeOf = (kinds: unknown, kind: Question["answerSpec"]["kind"]) => {
  const m = reg.get("mixed");
  const cfg = m?.configSchema.parse({ kinds });
  const q = [...IDS.map(pick), pick("q_ord_1")].find((x) => x.answerSpec.kind === kind) ?? { ...pick("q_capital_fr"), answerSpec: { kind } };
  return m?.route?.(cfg, q as Question); // oxlint-disable-line typescript/no-unsafe-type-assertion -- a question of that kind for routing only
};

describe("every category setting reaches the mechanic that plays the question", () => {
  it("by category, with every key set", () => {
    const rule = [{ type: "base", points: 42 }];
    const kinds = {
      choice: { shuffleOptions: true, allowChange: false, scoring: rule },
      poll: { mode: "per-answer", maxStrikes: 2, multiplier: 2 },
      oral: { lockoutOnWrong: false, scoring: rule },
      text: { allowChange: false, scoring: rule },
      number: { mode: "closest", allowChange: false, scoring: rule },
      order: { allowChange: false, scoring: rule },
    };
    expect(routeOf(kinds, "single")).toEqual({ id: "choice", config: { shuffleOptions: true, allowChange: false }, scoring: rule });
    expect(routeOf(kinds, "poll")).toEqual({ id: "poll-board", config: { maxStrikes: 2, multiplier: 2, scoring: "per-answer" } });
    expect(routeOf(kinds, "oral")).toEqual({ id: "buzzer", config: { lockoutOnWrong: false }, scoring: rule });
    expect(routeOf(kinds, "text")).toEqual({ id: "text-answer", config: { allowChange: false }, scoring: rule });
    expect(routeOf(kinds, "number")).toEqual({ id: "number-answer", config: { allowChange: false, mode: "closest" }, scoring: rule });
    expect(routeOf(kinds, "order")).toEqual({ id: "order", config: { allowChange: false }, scoring: rule });
    expect(routeOf({ pairs: { allowChange: false }, pin: { allowChange: false }, allocation: { allowChange: false, keepOneEmpty: false } }, "allocation")).toEqual({ id: "allocation", config: { allowChange: false, keepOneEmpty: false } });
  });

  it("and they change the game: no answer change on a QCM, the steal after 2 strikes on a survey", () => {
    const doc = structuredClone(MIXED);
    const r0 = doc.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { kinds: { choice: { allowChange: false }, poll: { maxStrikes: 2 } } };
    const game = GameDocument.parse(doc);
    const qcm = pick("q_capital_fr");
    const [a, b] = qcm.answerSpec.kind === "single" ? qcm.answerSpec.options.map((o) => o.id) : [];
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", a ?? "")], createGame(makeSession(game)));
    expect(() => run(reg, [answer("p_1", b ?? "")], g)).toThrow(/rejected/);
    const poll = run(reg, [...START, ctl({ type: "question.skip", roundIndex: 0, questionIndex: 0 }), ctl({ type: "question.present" }), ctl({ type: "poll.control", participantId: "p_1" }), ctl({ type: "question.open" }), ctl({ type: "answer.judge", correct: false }), ctl({ type: "answer.judge", correct: false })], createGame(makeSession(game)));
    expect(project(poll, { role: "control" }, reg).mechanic).toMatchObject({ stage: "steal", maxStrikes: 2 });
  });
});

describe("what a question is worth, in words (studio, control room, host)", () => {
  it("question > category > round, the mechanic's own points, the live stakes", () => {
    const doc = structuredClone(MIXED);
    const r0 = doc.format.rounds[0];
    const q0 = doc.questions.find((q) => q.id === "q_capital_fr");
    if (r0 === undefined || q0 === undefined) throw new Error("fixture");
    r0.scoring = [{ type: "base", points: 200 }];
    r0.mechanicConfig = { kinds: { text: { scoring: [{ type: "base", points: 300 }, { type: "timeDecay", minPoints: 100 }] } } };
    q0.scoring = [{ type: "base", points: 1000 }];
    const game = GameDocument.parse(doc);
    const round = game.format.rounds[0];
    if (round === undefined) throw new Error("fixture");
    const info = (id: string) => pointsInfo(round, game.questions.find((q) => q.id === id) ?? pick(id), reg);
    expect(info("q_capital_fr")).toMatchObject({ summary: "1000 pts", source: "question" });
    expect(info("q_txt_1")).toMatchObject({ summary: "300 → 100 pts (dégressif)", source: "category", why: "barème de sa catégorie (réponse libre)" });
    expect(info("q_num_1")).toMatchObject({ summary: "200 pts", source: "round" });
    expect(info("q_poll_breakfast")).toMatchObject({ source: "own", summary: "% des réponses trouvées" });
    const g = run(reg, [...START, ctl({ type: "question.setStakes", roundIndex: 0, questionIndex: 0, points: null, multiplier: 2 })], createGame(makeSession(game)));
    expect(project(g, { role: "control" }, reg).stakes).toMatchObject({ multiplier: 2, worth: "1000 pts · ×2" });
    const v = project(g, { role: "host" }, reg);
    if (v.role !== "host") throw new Error("host");
    expect(v.rundown[0]?.questions[0]?.points).toEqual({ summary: "1000 pts", why: "points de cette question" });
  });

  it("a ladder says it scores by its own steps, never a barème", () => {
    const ladder = DEMO_LADDER_GAME;
    const round = ladder.format.rounds[0];
    const q = ladder.questions[0];
    if (round === undefined || q === undefined) throw new Error("fixture");
    expect(pointsInfo(round, q, reg)).toMatchObject({ source: "own", summary: "gain du palier atteint" });
  });
});

