import { describe, expect, it } from "vitest";
import { createGame, decide, replay } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { participantTotal } from "./state.ts";
import { actor, addPlayers, answer, CONTROL, ctl, makeSession, run } from "./testing/harness.ts";

const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3)];
const OPEN_Q1 = [...START, ctl({ type: "question.present" }), ctl({ type: "question.open" })];

describe("question cycle (choice)", () => {
  it("plays a full game: present → open → answers → lock → reveal → next, scores in the ledger", () => {
    let g = run(reg, [...OPEN_Q1, answer("p_1", "b"), answer("p_2", "a"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })]);
    expect(g.state.phase).toBe("revealed");
    // p_1 answered 1 s after open on a 20 s timer: 100 - 50 * 1/20 = 97.5 → 98
    expect(participantTotal(g.state, "p_1")).toBe(98);
    expect(participantTotal(g.state, "p_2")).toBe(0);
    expect(g.state.ledger).toHaveLength(1);
    expect(g.state.ledger[0]).toMatchObject({ reason: "auto", questionId: "q_capital_fr", id: expect.stringMatching(/^se_\d+_0$/) });

    g = run(reg, [ctl({ type: "question.next" }), ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_3", "false"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], g);
    expect(participantTotal(g.state, "p_3")).toBeGreaterThan(0);

    g = run(reg, [ctl({ type: "question.present" }), ctl({ type: "question.open" }), answer("p_1", "a", "c"), answer("p_2", "a"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })], g);
    expect(g.state.phase).toBe("game.end");
    expect(participantTotal(g.state, "p_2")).toBe(0); // partial multi answer = wrong
  });

  it("rejects actions out of phase with a reason", () => {
    const g = run(reg, START);
    const r = decide(g, { action: { type: "question.reveal" }, actor: CONTROL, idempotencyKey: null }, 5_000_000, reg);
    expect(r).toMatchObject({ ok: false, error: { code: "wrong-phase" } });
  });

  it("lets a player change their answer until lock, then refuses", () => {
    let g = run(reg, [...OPEN_Q1, answer("p_1", "a"), answer("p_1", "b")]);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: ["b"] });
    g = run(reg, [ctl({ type: "question.lock" })], g);
    const [who, act] = answer("p_1", "c");
    expect(decide(g, { action: act, actor: who, idempotencyKey: null }, 9e9, reg).ok).toBe(false);
  });
});

describe("permissions and identity", () => {
  it("a player cannot answer for someone else", () => {
    const g = run(reg, OPEN_Q1);
    const r = decide(g, { action: { type: "answer.submit", participantId: "p_2", answer: { kind: "choice", optionIds: ["b"] } }, actor: actor("player", "p_1"), idempotencyKey: null }, 9e9, reg);
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("a player cannot drive the game", () => {
    const g = run(reg, OPEN_Q1);
    expect(decide(g, { action: { type: "question.reveal" }, actor: actor("player", "p_1"), idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("an eliminated player cannot answer", () => {
    const g = run(reg, [...OPEN_Q1, ctl({ type: "player.setStatus", participantId: "p_1", status: "eliminated" })]);
    const [who, act] = answer("p_1", "b");
    expect(decide(g, { action: act, actor: who, idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("control can enter an answer on behalf of a player (doc 09)", () => {
    const g = run(reg, [...OPEN_Q1, [CONTROL, { type: "answer.submit", participantId: "p_2", answer: { kind: "choice", optionIds: ["b"] } }]]);
    expect(project(g, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myAnswer: ["b"] });
  });
});

describe("server timers (injected, never read by the engine)", () => {
  it("timer.expired with the current timer id locks answers", () => {
    const g = run(reg, OPEN_Q1);
    expect(g.state.timer).not.toBeNull();
    const id = g.state.timer?.id ?? -1;
    const r = decide(g, { action: { type: "timer.expired", timerId: id }, actor: actor("system"), idempotencyKey: null }, 9e9, reg);
    expect(r.ok && r.value.game.state.phase).toBe("locked");
  });

  it("a stale expiration (timer replaced by timer.set) is rejected", () => {
    const g0 = run(reg, OPEN_Q1);
    const oldId = g0.state.timer?.id ?? -1;
    const g = run(reg, [ctl({ type: "timer.set", remainingMs: 30_000 })], g0);
    const r = decide(g, { action: { type: "timer.expired", timerId: oldId }, actor: actor("system"), idempotencyKey: null }, 9e9, reg);
    expect(r).toMatchObject({ ok: false, error: { code: "stale" } });
  });

  it("only the system can expire a timer", () => {
    const g = run(reg, OPEN_Q1);
    const r = decide(g, { action: { type: "timer.expired", timerId: g.state.timer?.id ?? 0 }, actor: CONTROL, idempotencyKey: null }, 9e9, reg);
    expect(r.ok).toBe(false);
  });
});

describe("scores = ledger, overrides always accepted", () => {
  it("adjust, set total, void — totals recomputed", () => {
    let g = run(reg, [...START, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 50, reason: "bonus" }), ctl({ type: "score.setTotal", target: { participantId: "p_1" }, total: 20 })]);
    expect(participantTotal(g.state, "p_1")).toBe(20);
    const first = g.state.ledger[0]?.id ?? "";
    g = run(reg, [ctl({ type: "score.void", entryId: first })], g);
    expect(participantTotal(g.state, "p_1")).toBe(-30);
    expect(g.state.ledger.map((e) => e.reason)).toEqual(["bonus", "manual"]);
  });

  it("score.adjust is accepted in any phase (lobby, open, revealed)", () => {
    for (const steps of [[...addPlayers(1)], OPEN_Q1]) {
      const g = run(reg, [...steps, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 5, reason: "manual" })]);
      expect(participantTotal(g.state, "p_1")).toBe(5);
    }
  });

  it("leaderboard uses competition ranking", () => {
    const g = run(reg, [...START, ctl({ type: "score.adjust", target: { participantId: "p_2" }, delta: 10, reason: "manual" }), ctl({ type: "score.adjust", target: { participantId: "p_3" }, delta: 10, reason: "manual" })]);
    expect(project(g, { role: "output", scene: "program" }, reg).leaderboard.map((r) => [r.participantId, r.rank])).toEqual([["p_2", 1], ["p_3", 1], ["p_1", 3]]);
  });
});

describe("undo (ADR-0010)", () => {
  it("undo without target cancels the last control decision, never a player answer", () => {
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "undo" })]);
    // Last control decision was question.open → back to presenting; p_1's answer is now invalid → skipped.
    expect(g.state.phase).toBe("presenting");
    expect(g.skipped.map((s) => s.type)).toEqual(["answer.submit"]);
    expect(g.events.at(-1)?.action.type).toBe("undo"); // journal is append-only
  });

  it("undo of a reveal removes its score entries", () => {
    const before = run(reg, [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "question.lock" })]);
    const g = run(reg, [ctl({ type: "question.reveal" }), ctl({ type: "undo" })], before);
    expect(g.state).toEqual({ ...before.state, lastSeq: g.state.lastSeq });
    expect(participantTotal(g.state, "p_1")).toBe(0);
  });

  it("undo of an undo is a redo", () => {
    const g1 = run(reg, [...START, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 7, reason: "manual" })]);
    const g2 = run(reg, [ctl({ type: "undo" })], g1);
    expect(participantTotal(g2.state, "p_1")).toBe(0);
    const undoSeq = g2.events.at(-1)?.seq ?? 0;
    const g3 = run(reg, [ctl({ type: "undo", targetSeq: undoSeq })], g2);
    expect(participantTotal(g3.state, "p_1")).toBe(7);
  });

  it("successive undos walk back through control decisions", () => {
    const g = run(reg, [...START, ctl({ type: "question.present" }), ctl({ type: "undo" }), ctl({ type: "undo" })]);
    // second undo cancels the last player.add
    expect(g.state.participants.map((p) => p.id)).toEqual(["p_1", "p_2"]);
  });

  it("refuses to undo an already cancelled event or an unknown seq", () => {
    const g = run(reg, [...START, ctl({ type: "undo", targetSeq: 2 })]);
    expect(decide(g, { action: { type: "undo", targetSeq: 2 }, actor: CONTROL, idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(g, { action: { type: "undo", targetSeq: 999 }, actor: CONTROL, idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("players cannot undo", () => {
    const g = run(reg, OPEN_Q1);
    expect(decide(g, { action: { type: "undo" }, actor: actor("player", "p_1"), idempotencyKey: null }, 9e9, reg).ok).toBe(false);
  });
});

describe("replay (crash recovery)", () => {
  it("rebuilds exactly the same game from the journal, undos included", () => {
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b"), answer("p_2", "c"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "undo" }), ctl({ type: "question.reveal" }), ctl({ type: "score.adjust", target: { participantId: "p_2" }, delta: 3, reason: "bonus" })]);
    const r = replay(g.session, g.events, reg);
    expect(r.state).toEqual(g.state);
    expect([...r.cancelledBy]).toEqual([...g.cancelledBy]);
  });

  it("same journal, same seed → same shuffled options", () => {
    const shuffled = { ...makeSession().game };
    const round = shuffled.format.rounds[0];
    if (round === undefined) throw new Error("fixture");
    const game = { ...shuffled, format: { ...shuffled.format, rounds: [{ ...round, mechanicConfig: { shuffleOptions: true } }] } };
    const steps = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "question.present" })];
    const a = run(reg, steps, createGame(makeSession(game, 123)));
    const b = replay(a.session, a.events, reg);
    expect(project(b, { role: "output", scene: "x" }, reg).mechanic?.options).toEqual(project(a, { role: "output", scene: "x" }, reg).mechanic?.options);
  });
});

describe("replay from a snapshot", () => {
  const steps = [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" }), ctl({ type: "question.present" })];

  it("gives the same game as a full replay", () => {
    const g = run(reg, steps);
    const cut = g.events.findIndex((e) => e.action.type === "question.reveal");
    const prefix = replay(g.session, g.events.slice(0, cut + 1), reg);
    const fromSnap = replay(g.session, g.events, reg, { seq: prefix.state.lastSeq, state: prefix.state });
    expect(fromSnap.state).toEqual(g.state);
  });

  it("falls back to a full replay when a later undo reaches before the snapshot", () => {
    const g0 = run(reg, steps);
    const snap = { seq: g0.state.lastSeq, state: g0.state };
    const revealSeq = g0.events.find((e) => e.action.type === "question.reveal")?.seq ?? 0;
    const g = run(reg, [ctl({ type: "undo", targetSeq: revealSeq })], g0);
    expect(replay(g.session, g.events, reg, snap).state).toEqual(g.state);
    expect(participantTotal(g.state, "p_1")).toBe(0);
  });
});
