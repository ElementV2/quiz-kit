import { describe, expect, it } from "vitest";
import { DEMO_LADDER_GAME, type Action, type ControlView, type GameDocument, type LadderMechanicView, type Question, type View, type Viewer } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { createRng } from "../../rng.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, CONTROL, ctl, makeSession, run, type Step } from "../../testing/harness.ts";
import { LadderConfig, ladder } from "./ladder.ts";

const ladderOf = (v: View): LadderMechanicView | null => (v.mechanic?.mechanic === "ladder" ? v.mechanic : null);

// ---------------------------------------------------------------------------------------------
// Contract suite: the candidate answers right most of the time (the generator peeks at the control
// view), control uses jokers and sometimes stops.
// ---------------------------------------------------------------------------------------------

function answerFor(view: View, picks: readonly number[], participantId: string, control: ControlView): Action | null {
  const m = ladderOf(view);
  const truth = ladderOf(control);
  if (m === null || truth === null) return null;
  const [p0 = 0, p1 = 0] = picks;
  const visible = m.options.filter((o) => !m.hidden.includes(o.id));
  const pick = p0 % 10 < 7 && truth.correct !== null ? truth.correct : (visible[p1 % Math.max(visible.length, 1)]?.id ?? "a");
  return { type: "answer.submit", participantId, answer: { kind: "choice", optionIds: [pick] } };
}

function controlActionFor(_control: ControlView, picks: readonly number[]): Action | null {
  const [p0 = 0] = picks;
  switch (p0 % 5) {
    case 0:
      return { type: "ladder.stop" };
    case 1:
    case 2:
      return { type: "joker.use", joker: "fifty" };
    default:
      return { type: "joker.use", joker: "audience" };
  }
}

function assertNoLeak(view: View, control: ControlView): void {
  const m = ladderOf(view);
  const truth = ladderOf(control);
  if (m === null || truth === null) return;
  if (truth.correct !== null) expect(m.hidden, "50:50 hid the correct answer").not.toContain(truth.correct);
  if (view.phase !== "revealed") {
    expect(["playing", "stopped"], `outcome leaked to ${view.role} before reveal`).toContain(m.status);
    expect(m.level, `level leaked to ${view.role} before reveal`).toBe(truth.level);
  }
  if (m.audience !== null) expect(Object.values(m.audience).reduce((a, b) => a + b, 0)).toBe(100);
}

/**
 * Six short ladders (3 questions, 2 to 4 steps) so that many ladders end — by top step, end of round,
 * fall or stop — within a property run. The contract suite registers 3 players: one becomes the candidate.
 */
const CONTRACT_GAME: GameDocument = {
  ...DEMO_LADDER_GAME,
  format: {
    ...DEMO_LADDER_GAME.format,
    participants: { mode: "solo", min: 1, max: 10 },
    rounds: [0, 1, 2, 3, 4, 5].flatMap((i) =>
      DEMO_LADDER_GAME.format.rounds.map((r) => ({
        ...r,
        id: `${r.id}_${i}`,
        questions: i % 2 === 0 ? r.questions.slice(0, 3) : r.questions.slice(3),
        mechanicConfig: {
          steps: [[100, 200], [100, 200, 500], [100, 200, 500, 1000]][i % 3],
          safeSteps: i % 3 === 2 ? [] : [0],
          jokers: i === 1 ? ["fifty"] : ["fifty", "audience"],
        },
      })),
    ),
  },
};

mechanicContractSuite({ mechanic: ladder, registry: reg, game: CONTRACT_GAME, answerFor, controlActionFor, assertNoLeak });

// ---------------------------------------------------------------------------------------------
// Scenarios — DEMO_LADDER_GAME: steps 200, 500, 1000, 5000, 20000, 100000, safe step index 2 (1000).
// Correct answers: q1 b, q2 d, q3 a, q4 c, q5 a, q6 c.
// ---------------------------------------------------------------------------------------------

const CORRECT = ["b", "d", "a", "c", "a", "c"] as const;
const WRONG = ["a", "a", "b", "a", "b", "a"] as const;

const START: Step[] = [ctl({ type: "game.start" }), ctl({ type: "player.add", participantId: "p_1", displayName: "Candidat", seat: 1, channel: "seat" }), ctl({ type: "round.start" })];
const say = (optionId: string, pid = "p_1"): Step => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "choice", optionIds: [optionId] } }];
const OPEN: Step[] = [ctl({ type: "question.present" }), ctl({ type: "question.open" })];
const SHOW: Step[] = [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];
const NEXT: Step = ctl({ type: "question.next" });
/** Plays question i with the given answer, up to reveal. */
const q = (i: number, right: boolean): Step[] => [...OPEN, say(right ? (CORRECT[i] ?? "a") : (WRONG[i] ?? "a")), ...SHOW];
/** Wins questions 0..n-1 (each followed by question.next). */
const climb = (n: number): Step[] => Array.from({ length: n }, (_, i) => [...q(i, true), NEXT]).flat();

const play = (steps: readonly Step[], game: GameDocument = DEMO_LADDER_GAME): Game => run(reg, steps, createGame(makeSession(game)));
const viewOf = (g: Game, viewer: Viewer = { role: "output", scene: "program" }): LadderMechanicView => {
  const m = ladderOf(project(g, viewer, reg));
  if (m === null) throw new Error("no ladder view");
  return m;
};
const rejection = (g: Game, action: Action, who = CONTROL) => {
  const r = decide(g, { action, actor: who, idempotencyKey: null }, 9e12, reg);
  return r.ok ? null : r.error.code;
};
const autoEntries = (g: Game) => g.state.ledger.filter((e) => e.reason === "auto" && !e.voided);

function withConfig(cfg: Record<string, unknown>, questions?: readonly string[]): GameDocument {
  const round = DEMO_LADDER_GAME.format.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return { ...DEMO_LADDER_GAME, format: { ...DEMO_LADDER_GAME.format, rounds: [{ ...round, mechanicConfig: cfg, questions: [...(questions ?? round.questions)] }] } };
}

describe("ladder progression", () => {
  it("climbs one step per right answer and writes nothing until the end", () => {
    const g = play([...START, ...climb(2), ...OPEN]);
    expect(viewOf(g)).toMatchObject({ level: 2, atStake: 2, gain: 500, secured: 0, status: "playing", candidate: "p_1" });
    expect(autoEntries(g)).toEqual([]);
  });

  it("stopping keeps the step reached and ends the round", () => {
    const g = play([...START, ...climb(2), ...OPEN, ctl({ type: "ladder.stop" }), ...SHOW]);
    expect(viewOf(g)).toMatchObject({ status: "stopped", level: 2, gain: 500, correct: "a" });
    expect(autoEntries(g)).toMatchObject([{ target: { participantId: "p_1" }, delta: 500, questionId: "q_lad_3" }]);
    expect(run(reg, [NEXT], g).state.phase).toBe("game.end");
  });

  it("a wrong answer before any safe step loses everything", () => {
    const g = play([...START, ...climb(1), ...q(1, false)]);
    expect(viewOf(g)).toMatchObject({ status: "lost", level: 1, gain: 0, atStake: null });
    expect(participantTotal(g.state, "p_1")).toBe(0);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "wrong" });
    expect(run(reg, [NEXT], g).state.phase).toBe("game.end");
  });

  it("a wrong answer after a safe step falls back to it", () => {
    const g = play([...START, ...climb(4), ...q(4, false)]);
    expect(viewOf(g)).toMatchObject({ status: "lost", level: 4, gain: 1000, secured: 1000 });
    expect(participantTotal(g.state, "p_1")).toBe(1000);
  });

  it("the top step wins the jackpot", () => {
    const g = play([...START, ...climb(5), ...q(5, true)]);
    expect(viewOf(g)).toMatchObject({ status: "won", level: 6, gain: 100_000, atStake: null });
    expect(autoEntries(g)).toMatchObject([{ delta: 100_000, questionId: "q_lad_6" }]);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
  });

  it("running out of questions banks the step reached", () => {
    const g = play([...START, ...climb(1), ...q(1, true)], withConfig({ steps: [200, 500, 1000], safeSteps: [] }, ["q_lad_1", "q_lad_2"]));
    expect(viewOf(g)).toMatchObject({ status: "won", gain: 500 });
    expect(participantTotal(g.state, "p_1")).toBe(500);
  });

  it("a question skipped without reveal keeps the level", () => {
    const g = play([...START, ...climb(1), ...OPEN, say("a"), NEXT, ...OPEN]);
    expect(viewOf(g)).toMatchObject({ level: 1, atStake: 1, answer: null });
  });

  it("undoing the final reveal removes the gain; replay agrees", () => {
    const g = play([...START, ...climb(3), ...q(3, false)]);
    expect(participantTotal(g.state, "p_1")).toBe(1000);
    const u = run(reg, [ctl({ type: "undo" })], g);
    expect(participantTotal(u.state, "p_1")).toBe(0);
    expect(replay(u.session, u.events, reg).state).toEqual(u.state);
  });

  it("removing the candidate resets the progression", () => {
    const g = play([...START, ...climb(2), ctl({ type: "player.remove", participantId: "p_1" }), ctl({ type: "player.add", participantId: "p_1", displayName: "Autre", channel: "seat" }), ...OPEN]);
    expect(viewOf(g)).toMatchObject({ level: 0, candidate: null, gain: 0 });
  });
});

describe("ladder jokers", () => {
  it("50:50 hides two wrong options for everyone, deterministically", () => {
    const g = play([...START, ...OPEN, ctl({ type: "joker.use", joker: "fifty" })]);
    const v = viewOf(g, { role: "player", participantId: "p_1" });
    expect(v.hidden).toHaveLength(2);
    expect(v.hidden).not.toContain("b");
    expect(v.jokers).toEqual({ fifty: "used", audience: "available" });
    expect(viewOf(replay(g.session, g.events, reg)).hidden).toEqual(v.hidden);
    expect(rejection(g, { type: "joker.use", joker: "fifty" })).toBe("conflict");
    const hiddenOption = v.hidden[0] ?? "a";
    expect(rejection(g, { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: [hiddenOption] } })).toBe("invalid");
  });

  it("audience poll: deterministic % summing to 100, zero on hidden options", () => {
    const g = play([...START, ...OPEN, ctl({ type: "joker.use", joker: "fifty" }), ctl({ type: "joker.use", joker: "audience" })]);
    const v = viewOf(g, { role: "output", scene: "program" });
    const poll = v.audience ?? {};
    expect(Object.keys(poll).toSorted()).toEqual(["a", "b", "c", "d"]);
    expect(Object.values(poll).reduce((a, b) => a + b, 0)).toBe(100);
    for (const h of v.hidden) expect(poll[h]).toBe(0);
    expect(poll["b"]).toBeGreaterThanOrEqual(35);
    expect(viewOf(replay(g.session, g.events, reg)).audience).toEqual(poll);
    expect(v.correct).toBeNull();
  });

  it("each joker is used once per game, not once per question", () => {
    const g = play([...START, ...OPEN, ctl({ type: "joker.use", joker: "audience" }), say("b"), ...SHOW, NEXT, ...OPEN]);
    expect(viewOf(g)).toMatchObject({ audience: null, hidden: [], jokers: { fifty: "available", audience: "used" } });
    expect(rejection(g, { type: "joker.use", joker: "audience" })).toBe("conflict");
  });

  it("jokers not enabled by the config are disabled", () => {
    const g = play([...START, ...OPEN], withConfig({ steps: [100, 200], safeSteps: [], jokers: ["fifty"] }));
    expect(viewOf(g).jokers).toEqual({ fifty: "available", audience: "disabled" });
    expect(rejection(g, { type: "joker.use", joker: "audience" })).toBe("forbidden");
  });

  it("refuses jokers after the answer or outside the question", () => {
    expect(rejection(play([...START, ...OPEN, say("b")]), { type: "joker.use", joker: "fifty" })).toBe("conflict");
    expect(rejection(play([...START, ...q(0, true)]), { type: "joker.use", joker: "fifty" })).toBe("wrong-phase");
  });
});

describe("ladder projections and rejections", () => {
  it("never shows the outcome before reveal, even for a wrong final answer", () => {
    const g = play([...START, ...climb(1), ...OPEN, say("a"), ctl({ type: "question.lock" })]);
    for (const viewer of [{ role: "player", participantId: "p_1" }, { role: "output", scene: "program" }] as const) {
      expect(viewOf(g, viewer)).toMatchObject({ correct: null, status: "playing", level: 1, gain: 200, answer: "a" });
      expect(JSON.stringify(project(g, viewer, reg))).not.toContain("Golfe de Gascogne");
    }
    expect(viewOf(g, { role: "host" })).toMatchObject({ correct: "d" });
  });

  it("only the candidate answers", () => {
    const two = { ...DEMO_LADDER_GAME, format: { ...DEMO_LADDER_GAME.format, participants: { mode: "solo" as const, min: 1, max: 2 } } };
    const g = play([...START, ctl({ type: "player.add", participantId: "p_2", displayName: "Public", channel: "seat" }), ...OPEN, say("b")], two);
    expect(rejection(g, { type: "answer.submit", participantId: "p_2", answer: { kind: "choice", optionIds: ["b"] } })).toBe("conflict");
  });

  it("refuses to stop without candidate, after the answer, or twice", () => {
    expect(rejection(play([...START, ...OPEN]), { type: "ladder.stop" })).toBe("conflict");
    expect(rejection(play([...START, ...climb(1), ...OPEN, say("d")]), { type: "ladder.stop" })).toBe("conflict");
    const stopped = play([...START, ...climb(1), ...OPEN, ctl({ type: "ladder.stop" })]);
    expect(rejection(stopped, { type: "ladder.stop" })).toBe("conflict");
    expect(rejection(stopped, { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["d"] } })).toBe("conflict");
  });

  it("validates the config", () => {
    expect(LadderConfig.safeParse({ steps: [100, 50] }).success).toBe(false);
    expect(LadderConfig.safeParse({ steps: [100, 200], safeSteps: [2] }).success).toBe(false);
    expect(LadderConfig.safeParse({ steps: [100, 200], jokers: ["fifty", "fifty"] }).success).toBe(false);
    expect(LadderConfig.safeParse({ steps: [100, 200] }).data).toEqual({ steps: [100, 200], safeSteps: [], jokers: ["fifty", "audience"] });
  });

  it("refuses non-single questions", () => {
    const oral: Question = { id: "q_o", prompt: { text: "?" }, answerSpec: { kind: "oral", expected: "x" }, hints: [], tags: [] };
    const r = ladder.init({ steps: [1], safeSteps: [], jokers: [] }, oral, { at: 0, phase: "idle", lockedAt: null, rng: createRng(1, 1) }, { previous: null, questionIndex: 0, questionsLeft: 0, questions: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});

describe("review of phase 1 mechanics — ladder", () => {
  it("#1 a second ladder on the same questions never voids the first one's gain", () => {
    const round = DEMO_LADDER_GAME.format.rounds[0];
    if (round === undefined) throw new Error("fixture");
    const twice: GameDocument = { ...DEMO_LADDER_GAME, format: { ...DEMO_LADDER_GAME.format, rounds: [round, { ...round, id: "r_ladder_2" }] } };
    const first = play([...START, ...climb(2), ...OPEN, ctl({ type: "ladder.stop" }), ...SHOW, NEXT], twice);
    expect(first.state.phase).toBe("round.end");
    const g = run(reg, [ctl({ type: "round.start" }), ...climb(2), ...q(2, true)], first);
    expect(participantTotal(g.state, "p_1")).toBe(500);
    expect(autoEntries(g)).toMatchObject([{ delta: 500, questionId: "q_lad_3" }]);
  });

  it("#2a skipping the last question banks the step reached", () => {
    const g = play([...START, ...climb(1), ...OPEN, say("a"), NEXT], withConfig({ steps: [200, 500, 1000], safeSteps: [] }, ["q_lad_1", "q_lad_2"]));
    expect(g.state.phase).toBe("game.end");
    expect(participantTotal(g.state, "p_1")).toBe(200);
  });

  it("#2b a stop followed by question.next without reveal banks the step and ends the round", () => {
    const g = play([...START, ...climb(2), ...OPEN, ctl({ type: "ladder.stop" }), NEXT]);
    expect(g.state.phase).toBe("game.end");
    expect(autoEntries(g)).toMatchObject([{ delta: 500, questionId: "q_lad_3" }]);
    expect(replay(g.session, g.events, reg).state).toEqual(g.state);
  });

  it("#2c a ladder ended by its reveal is not banked twice by question.next", () => {
    const g = play([...START, ...climb(4), ...q(4, false), NEXT]);
    expect(autoEntries(g)).toHaveLength(1);
    expect(participantTotal(g.state, "p_1")).toBe(1000);
  });

  it("#3 going back to a question already played is refused (no double step)", () => {
    const g = play([...START, ...climb(1)]);
    expect(rejection(g, { type: "question.present", questionIndex: 0 })).toBe("conflict");
    expect(viewOf(run(reg, [ctl({ type: "question.present", questionIndex: 1 })], g))).toMatchObject({ level: 1 });
  });
});
