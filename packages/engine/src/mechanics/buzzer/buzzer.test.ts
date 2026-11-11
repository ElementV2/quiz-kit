import { describe, expect, it } from "vitest";
import { DEMO_BUZZER_GAME, type Action, type BuzzerMechanicView, type ControlView, type GameDocument, type Question, type View, type Viewer } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { createRng } from "../../rng.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, CONTROL, ctl, makeSession, run, type Step } from "../../testing/harness.ts";
import { buzzer } from "./buzzer.ts";

const buzzerOf = (v: View): BuzzerMechanicView | null => (v.mechanic?.mechanic === "buzzer" ? v.mechanic : null);

// ---------------------------------------------------------------------------------------------
// Contract suite: players buzz, the operator judges whoever has the hand.
// ---------------------------------------------------------------------------------------------

const answerFor = (_view: View, _picks: readonly number[], participantId: string): Action => ({ type: "buzz", participantId });

function controlActionFor(control: ControlView, picks: readonly number[]): Action | null {
  const m = buzzerOf(control);
  const [p0 = 0, p1 = 0] = picks;
  if (m === null || p0 % 6 === 0) {
    // Any judgement, valid or not (wrong player, no player): exercises rejections.
    return { type: "answer.judge", participantId: `p_${(p1 % 3) + 1}`, correct: p1 % 2 === 0 };
  }
  if (m.hand === null) return p0 % 4 === 0 ? { type: "buzz", participantId: `p_${(p1 % 3) + 1}` } : null;
  return { type: "answer.judge", participantId: m.hand, correct: p1 % 2 === 0 };
}

function assertNoLeak(view: View, control: ControlView): void {
  const m = buzzerOf(view);
  const full = buzzerOf(control);
  if (m === null || full === null) return;
  if (view.role === "player") {
    expect(m.queue, "queue sent to a tablet").toBeNull();
    expect(m.lockedOut, "lock-outs sent to a tablet").toBeNull();
  } else {
    expect(m.me, "player state sent to an output").toBeNull();
  }
  if (view.phase !== "revealed") {
    expect(m.expected, `expected answer leaked to ${view.role}`).toBeNull();
    if (full.expected !== null) expect(JSON.stringify(view), `expected answer leaked to ${view.role}`).not.toContain(JSON.stringify(full.expected));
  }
}

const CONTRACT_GAME: GameDocument = {
  ...DEMO_BUZZER_GAME,
  format: {
    ...DEMO_BUZZER_GAME.format,
    rounds: DEMO_BUZZER_GAME.format.rounds.flatMap((r) => [r, { ...r, id: `${r.id}_free`, mechanicConfig: { lockoutOnWrong: false } }]),
  },
};

mechanicContractSuite({ mechanic: buzzer, registry: reg, game: CONTRACT_GAME, answerFor, controlActionFor, assertNoLeak });

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const buzz = (pid: string): Step => [actor("player", pid), { type: "buzz", participantId: pid }];
const judge = (participantId: string, correct: boolean): Step => ctl({ type: "answer.judge", participantId, correct });
const OPEN: Step[] = [ctl({ type: "game.start" }), ...addPlayers(3), ctl({ type: "round.start" }), ctl({ type: "question.present" })];
const END: Step[] = [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })];

const play = (steps: readonly Step[], game: GameDocument = DEMO_BUZZER_GAME): Game => run(reg, steps, createGame(makeSession(game)));
const viewOf = (g: Game, viewer: Viewer): BuzzerMechanicView => {
  const m = buzzerOf(project(g, viewer, reg));
  if (m === null) throw new Error("no buzzer view");
  return m;
};
const rejection = (g: Game, action: Action, who = CONTROL) => {
  const r = decide(g, { action, actor: who, idempotencyKey: null }, 9e12, reg);
  return r.ok ? null : r.error.code;
};

function withConfig(cfg: Record<string, unknown>): GameDocument {
  const round = DEMO_BUZZER_GAME.format.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return { ...DEMO_BUZZER_GAME, format: { ...DEMO_BUZZER_GAME.format, rounds: [{ ...round, mechanicConfig: cfg }] } };
}

describe("buzzer flow", () => {
  it("first journaled buzz takes the hand, the others queue", () => {
    const g = play([...OPEN, buzz("p_2"), buzz("p_1"), buzz("p_3")]);
    expect(viewOf(g, { role: "control" })).toMatchObject({ hand: "p_2", queue: ["p_2", "p_1", "p_3"], winner: null });
  });

  it("a wrong answer locks the player out and passes the hand; a right one closes the question", () => {
    const g = play([...OPEN, buzz("p_2"), buzz("p_1"), judge("p_2", false), judge("p_1", true)]);
    expect(viewOf(g, { role: "host" })).toMatchObject({ hand: null, winner: "p_1", queue: [], lockedOut: ["p_2"] });
    expect(rejection(g, { type: "buzz", participantId: "p_3" }, actor("player", "p_3"))).toBe("conflict");
    const done = run(reg, END, g);
    expect([participantTotal(done.state, "p_1"), participantTotal(done.state, "p_2"), participantTotal(done.state, "p_3")]).toEqual([100, -50, 0]);
    expect(project(done, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct" });
    expect(project(done, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myResult: "wrong" });
    expect(project(done, { role: "player", participantId: "p_3" }, reg)).toMatchObject({ myResult: "none" });
  });

  it("a locked-out player cannot buzz again", () => {
    const g = play([...OPEN, buzz("p_2"), judge("p_2", false)]);
    expect(rejection(g, { type: "buzz", participantId: "p_2" }, actor("player", "p_2"))).toBe("forbidden");
    expect(viewOf(g, { role: "player", participantId: "p_2" }).me).toEqual({ hasHand: false, queuePosition: null, lockedOut: true, canBuzz: false });
  });

  it("without lockout, a wrong player may buzz again (back of the queue) and is penalised per wrong answer", () => {
    const g = play([...OPEN, buzz("p_2"), buzz("p_1"), judge("p_2", false), buzz("p_2"), judge("p_1", false), judge("p_2", false), ...END], withConfig({ lockoutOnWrong: false }));
    expect([participantTotal(g.state, "p_1"), participantTotal(g.state, "p_2")]).toEqual([-50, -100]);
  });

  it("judging after the lock is allowed for whoever still has the hand", () => {
    const g = play([...OPEN, buzz("p_3"), ctl({ type: "question.lock" }), judge("p_3", true), ctl({ type: "question.reveal" })]);
    expect(participantTotal(g.state, "p_3")).toBe(100);
  });

  it("removing the player who has the hand passes it on", () => {
    const g = play([...OPEN, buzz("p_1"), buzz("p_2"), ctl({ type: "player.remove", participantId: "p_1" })]);
    expect(viewOf(g, { role: "control" })).toMatchObject({ hand: "p_2", queue: ["p_2"] });
  });

  it("default undo never cancels a buzz; an explicit one does, and replay agrees", () => {
    const g = play([...OPEN, buzz("p_1"), ctl({ type: "undo" })]);
    expect(g.state.phase).toBe("idle"); // the undo cancelled the presentation (it opened the buzzers), the buzz is skipped
    const h = play([...OPEN, buzz("p_1"), buzz("p_2")]);
    const seq = h.events.find((e) => e.action.type === "buzz")?.seq ?? 0;
    const u = run(reg, [ctl({ type: "undo", targetSeq: seq })], h);
    expect(viewOf(u, { role: "control" })).toMatchObject({ hand: "p_2" });
    expect(replay(u.session, u.events, reg).state).toEqual(u.state);
  });
});

describe("buzzer projections", () => {
  it("tells a player whether they have the hand, are queued or can buzz — nothing about others", () => {
    const g = play([...OPEN, buzz("p_2"), buzz("p_1")]);
    expect(viewOf(g, { role: "player", participantId: "p_2" })).toMatchObject({ hand: "p_2", queue: null, lockedOut: null, me: { hasHand: true, queuePosition: 1, lockedOut: false, canBuzz: false } });
    expect(viewOf(g, { role: "seat", seat: 1 }).me).toEqual({ hasHand: false, queuePosition: 2, lockedOut: false, canBuzz: false });
    expect(viewOf(g, { role: "player", participantId: "p_3" }).me).toEqual({ hasHand: false, queuePosition: null, lockedOut: false, canBuzz: true });
    expect(viewOf(g, { role: "output", scene: "program" })).toMatchObject({ queue: ["p_2", "p_1"], me: null });
  });

  it("keeps the expected answer and notes for host / control until reveal", () => {
    const g = play([...OPEN, buzz("p_1"), judge("p_1", true)]);
    for (const viewer of [{ role: "player", participantId: "p_2" }, { role: "output", scene: "program" }] as const) {
      const json = JSON.stringify(project(g, viewer, reg));
      expect(json).not.toContain("Everest");
      expect(json).not.toContain("Chomolungma");
      expect(viewOf(g, viewer)).toMatchObject({ expected: null, correct: null, winner: "p_1" });
    }
    expect(viewOf(g, { role: "host" }).expected).toBe("L'Everest (8 849 m)");
    expect(viewOf(run(reg, END, g), { role: "output", scene: "program" }).expected).toBe("L'Everest (8 849 m)");
  });

  it("shows spoken options of a single question to all, the right one to host / control only", () => {
    const g = play([...OPEN, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" }), ctl({ type: "question.present" })]);
    expect(viewOf(g, { role: "player", participantId: "p_1" })).toMatchObject({ kind: "single", correct: null, expected: null, options: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] });
    expect(viewOf(g, { role: "control" })).toMatchObject({ correct: "c" });
  });
});

describe("buzzer rejections", () => {
  const open = play(OPEN);
  it("rejects buzzes outside open answers, for someone else, twice, or by an inactive player", () => {
    expect(rejection(play(OPEN.slice(0, -1)), { type: "buzz", participantId: "p_1" }, actor("player", "p_1"))).toBe("wrong-phase");
    expect(rejection(open, { type: "buzz", participantId: "p_2" }, actor("player", "p_1"))).toBe("forbidden");
    expect(rejection(play([...OPEN, buzz("p_1")]), { type: "buzz", participantId: "p_1" }, actor("player", "p_1"))).toBe("conflict");
    const out = play([...OPEN, ctl({ type: "player.setStatus", participantId: "p_1", status: "eliminated" })]);
    expect(rejection(out, { type: "buzz", participantId: "p_1" }, actor("player", "p_1"))).toBe("forbidden");
  });

  it("only judges the player who has the hand", () => {
    const g = play([...OPEN, buzz("p_1"), buzz("p_2")]);
    expect(rejection(g, { type: "answer.judge", participantId: "p_2", correct: true })).toBe("conflict");
    expect(rejection(g, { type: "answer.judge", correct: true })).toBe("invalid");
    expect(rejection(open, { type: "answer.judge", participantId: "p_1", correct: true })).toBe("conflict");
    expect(rejection(g, { type: "answer.judge", participantId: "p_9", correct: true })).toBe("not-found");
  });

  it("rejects answer.submit and foreign actions", () => {
    expect(rejection(open, { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } })).toBe("unsupported");
    expect(rejection(open, { type: "element.reveal", index: 0 })).toBe("unsupported");
  });

  it("refuses question kinds other than oral and single", () => {
    const poll: Question = { id: "q_p", prompt: { text: "?" }, answerSpec: { kind: "poll", options: [{ id: "a", label: "A", value: 1 }] }, hints: [], tags: [] };
    const r = buzzer.init({ lockoutOnWrong: true }, poll, { at: 0, phase: "idle", lockedAt: null, rng: createRng(1, 1) }, { previous: null, questionIndex: 0, questionsLeft: 0, questions: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
});
