import { describe, expect, it } from "vitest";
import { DEMO_GAME, DEMO_TEXT_GAME, type Event } from "@quiz/schema";
import { CorruptJournalError, createGame, decide, replay } from "./game.ts";
import { defaultRegistry as reg, defaultRegistry } from "./index.ts";
import { createRegistry } from "./mechanic.ts";
import { project } from "./project.ts";
import { participantTotal, teamTotal } from "./state.ts";
import { actor, addPlayers, answer, CONTROL, ctl, makeSession, run } from "./testing/harness.ts";

/** One test per finding of the first engine review (keeps them fixed). */

const START = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2)];
const OPEN_Q1 = [...START, ctl({ type: "question.present" })];
const lastSeq = (g: { events: readonly Event[] }): number => g.events.at(-1)?.seq ?? 0;

describe("review #1 — multi-level undo / redo / re-undo", () => {
  it("cancelling a redo re-applies the original undo", () => {
    let g = run(reg, [...START, ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 7, reason: "manual" })]);
    g = run(reg, [ctl({ type: "undo" })], g); // U0 cancels +7
    expect(participantTotal(g.state, "p_1")).toBe(0);
    g = run(reg, [ctl({ type: "undo", targetSeq: lastSeq(g) })], g); // U1 = redo
    expect(participantTotal(g.state, "p_1")).toBe(7);
    g = run(reg, [ctl({ type: "undo", targetSeq: lastSeq(g) })], g); // U2 cancels the redo
    expect(participantTotal(g.state, "p_1")).toBe(0);
    g = run(reg, [ctl({ type: "undo", targetSeq: lastSeq(g) })], g); // U3 cancels U2
    expect(participantTotal(g.state, "p_1")).toBe(7);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });

  it("journals the resolved target so replay never guesses", () => {
    const g = run(reg, [...START, ctl({ type: "undo" })]);
    expect(g.events.at(-1)?.action).toEqual({ type: "undo", targetSeq: lastSeq(g) - 1 });
  });
});

describe("review #2 — a question cannot be scored twice", () => {
  it("round.start without index is refused while questions remain", () => {
    const g = run(reg, [...OPEN_Q1, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })]);
    expect(decide(g, { action: { type: "round.start" }, actor: CONTROL, idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("replaying a question replaces its automatic points", () => {
    let g = run(reg, [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })]);
    const first = participantTotal(g.state, "p_1");
    g = run(reg, [ctl({ type: "question.present", questionIndex: 0 }), answer("p_1", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(first);
    expect(g.state.ledger.filter((e) => e.questionId === "q_capital_fr" && !e.voided)).toHaveLength(1);
  });
});

describe("review #3 — removed players leave no trace", () => {
  it("a re-added id does not inherit the previous answer", () => {
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "player.remove", participantId: "p_1" }), ctl({ type: "player.add", participantId: "p_1", displayName: "Nouveau", channel: "seat" })]);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: null });
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ answeredCount: 0 });
  });
});

describe("review #4 — undo right after an auto-lock re-opens answers", () => {
  it("default undo targets the timer expiration, keeping answers", () => {
    const g0 = run(reg, [...OPEN_Q1, answer("p_1", "b")]);
    const g1 = run(reg, [[actor("system"), { type: "timer.expired", timerId: g0.state.timer?.id ?? 0 }], ctl({ type: "undo" })], g0);
    expect(g1.state.phase).toBe("open");
    expect(g1.skipped).toEqual([]);
    expect(project(g1, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: ["b"] });
  });

  it("default undo skips events that already have no effect", () => {
    // undo question.open → the answer is skipped; next default undo must not pick that answer or a no-op.
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b"), ctl({ type: "undo" }), ctl({ type: "undo" })]);
    expect(g.state.phase).toBe("idle"); // second undo cancelled question.present
  });
});

describe("review #5 — team totals never change retroactively", () => {
  it("moving or removing a player keeps the team's past points", () => {
    let g = run(reg, [
      ctl({ type: "team.add", teamId: "t_a", name: "A", color: "#ff0000" }),
      ctl({ type: "team.add", teamId: "t_b", name: "B", color: "#0000ff" }),
      ...START,
      ctl({ type: "player.setTeam", participantId: "p_1", teamId: "t_a" }),
      ctl({ type: "score.adjust", target: { participantId: "p_1" }, delta: 50, reason: "bonus" }),
      ctl({ type: "player.setTeam", participantId: "p_1", teamId: "t_b" }),
    ]);
    expect([teamTotal(g.state, "t_a"), teamTotal(g.state, "t_b")]).toEqual([50, 0]);
    g = run(reg, [ctl({ type: "player.remove", participantId: "p_1" })], g);
    expect(teamTotal(g.state, "t_a")).toBe(50);
  });
});

describe("review #6/#7 — snapshots and journal are validated", () => {
  it("ignores a snapshot whose mechanic state is invalid (full replay instead)", () => {
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b")]);
    const bad = { ...g.state, mechanic: { id: "choice", state: { garbage: true } } };
    expect(replay(g.session, g.events, reg, { seq: lastSeq(g), state: bad }).state).toEqual(g.state);
  });

  it("refuses a non-contiguous journal", () => {
    const g = run(reg, START);
    const broken = g.events.toReversed();
    expect(() => replay(g.session, broken, reg)).toThrow(CorruptJournalError);
  });
});

describe("review #9/#10 — timers and decay window", () => {
  it("timer.set keeps the round's autoLock=false after timer.stop", () => {
    const round = DEMO_GAME.format.rounds[0];
    if (round === undefined) throw new Error("fixture");
    const game = { ...DEMO_GAME, format: { ...DEMO_GAME.format, rounds: [{ ...round, timer: { durationMs: 20_000, autoLock: false } }] } };
    let g = run(reg, [...OPEN_Q1, ctl({ type: "timer.stop" }), ctl({ type: "timer.set", remainingMs: 10_000 })], createGame(makeSession(game)));
    g = run(reg, [[actor("system"), { type: "timer.expired", timerId: g.state.timer?.id ?? 0 }]], g);
    expect(g.state.phase).toBe("open");
  });

  it("extending the timer widens the decay window", () => {
    // Answer 25 s after open: beyond the 20 s round timer, but inside a window extended to 40 s.
    const g0 = run(reg, [...OPEN_Q1, ctl({ type: "timer.set", remainingMs: 39_000 })]);
    let at = 0;
    let g = g0;
    for (const [who, a] of [answer("p_1", "b"), [CONTROL, { type: "question.lock" }] as const, [CONTROL, { type: "question.reveal" }] as const]) {
      at = at === 0 ? (g.state.openedAt ?? 0) + 25_000 : at + 1000;
      const r = decide(g, { action: a, actor: who, idempotencyKey: null }, at, reg);
      if (!r.ok) throw new Error(r.error.message);
      g = r.value.game;
    }
    // window 40 s → 100 - 50 * 25/40 = 68.75 → 69 (not the 50 floor of a 20 s window)
    expect(participantTotal(g.state, "p_1")).toBe(69);
  });
});

function withRound(patch: Record<string, unknown>): ReturnType<typeof createGame> {
  const round = DEMO_GAME.format.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return createGame(makeSession({ ...DEMO_GAME, format: { ...DEMO_GAME.format, rounds: [{ ...round, ...patch }] } }));
}

function present(g: ReturnType<typeof createGame>): ReturnType<typeof decide> {
  return decide(run(reg, START, g), { action: { type: "question.present" }, actor: CONTROL, idempotencyKey: null }, 9e9, reg);
}

describe("failure cases at question.present", () => {

  it("unknown mechanic", () => {
    expect(present(withRound({ mechanic: "telepathy" }))).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  it("invalid mechanic config", () => {
    expect(present(withRound({ mechanicConfig: { shuffleOptions: "yes" } }))).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});

describe("phase 1 review — replay scope and snapshots", () => {
  it("the same question in two rounds keeps the first round's points", () => {
    const round = DEMO_GAME.format.rounds[0];
    if (round === undefined) throw new Error("fixture");
    const game = { ...DEMO_GAME, format: { ...DEMO_GAME.format, rounds: [{ ...round, questions: ["q_capital_fr"] }, { ...round, id: "r_2", questions: ["q_capital_fr"] }] } };
    const once = [ctl({ type: "question.present" }), answer("p_1", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })];
    const g = run(reg, [...START, ...once, ctl({ type: "round.start" }), ...once], createGame(makeSession(game)));
    expect(g.state.ledger.filter((e) => e.reason === "auto" && !e.voided)).toHaveLength(2);
  });

  it("a snapshot from an older version (no carry) is ignored without throwing", () => {
    const g = run(reg, [...OPEN_Q1, answer("p_1", "b")]);
    const { carry: _carry, roundLedgerStart: _start, ...old } = g.state;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: simulates a snapshot written by an older engine
    const state = old as unknown as typeof g.state;
    expect(replay(g.session, g.events, reg, { seq: lastSeq(g), state }).state).toEqual(g.state);
  });
});

describe("projection cost with 500 tablets (review I4)", () => {
  it("judges once per mechanic state, not once per player view", () => {
    let calls = 0;
    const base = defaultRegistry.get("text-answer");
    if (base === null) throw new Error("text-answer registered");
    const counting = createRegistry([{ ...base, judge: (st: unknown) => { calls++; return base.judge(st); } }, ...defaultRegistry.ids().filter((id) => id !== "text-answer").flatMap((id) => { const m = defaultRegistry.get(id); return m === null ? [] : [m]; })]);
    const players = Array.from({ length: 500 }, (_, i) => ctl({ type: "player.add", participantId: `p_${i + 1}`, displayName: `J${i + 1}`, channel: "play" }));
    const answers = Array.from({ length: 500 }, (_, i) => [actor("player", `p_${i + 1}`), { type: "answer.submit", participantId: `p_${i + 1}`, answer: { kind: "text", text: i % 2 === 0 ? "Van Gogh" : "Monet" } }] as const);
    const g = run(counting, [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...players, ctl({ type: "question.present" }), ...answers, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(DEMO_TEXT_GAME)));
    calls = 0;
    for (let i = 1; i <= 500; i++) project(g, { role: "player", participantId: `p_${i}` }, counting);
    expect(calls).toBe(1);
    expect(project(g, { role: "player", participantId: "p_2" }, counting)).toMatchObject({ myResult: "wrong" });
  });
});
