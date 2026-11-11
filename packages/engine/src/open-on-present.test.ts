import { describe, expect, it } from "vitest";
import { DEMO_BOARD_GAME, DEMO_BUZZER_GAME, DEMO_CHAIN_GAME, DEMO_CHAT_GAME, DEMO_GAME, DEMO_HINTS_GAME, DEMO_LADDER_GAME, DEMO_POLL_GAME, type Action, type GameDocument } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { actor, addPlayers, answer, ctl, makeSession, run, type Step } from "./testing/harness.ts";

/**
 * `Round.openOnPresent` (absent = true): « Présenter » opens the answers at once, timer armed by that same event, exactly
 * like `question.open`; false keeps a reading step (`presenting`, then « Ouvrir les réponses »).
 */

const reading = (doc: GameDocument): GameDocument => ({ ...doc, format: { ...doc.format, rounds: doc.format.rounds.map((r) => ({ ...r, openOnPresent: false })) } });
const START: Step[] = [...addPlayers(2), ctl({ type: "game.start" }), ctl({ type: "round.start" })];
const PRESENT = ctl({ type: "question.present" });
const OPEN = ctl({ type: "question.open" });
const play = (steps: readonly Step[], doc: GameDocument): Game => run(reg, steps, createGame(makeSession(doc)));
const ok = (g: Game, [who, action]: Step): boolean => decide(g, { action, actor: who, idempotencyKey: null }, 9_000_000 + g.events.length * 1000, reg).ok;
const at = (g: Game): number => g.events.at(-1)?.at ?? 0;
/** What a viewer of the question sees once the answers are open (same whatever event opened them). */
const seen = (g: Game) => {
  const v = project(g, { role: "control" }, reg);
  return { phase: g.state.phase, windowMs: g.state.windowMs, timer: g.state.timer?.durationMs, view: v.mechanic, answers: v.role === "control" ? v.answers.map((x) => x.optionIds) : null };
};

describe("openOnPresent (default)", () => {
  it("« Présenter » opens the answers: timer armed by the presentation, like question.open", () => {
    const g = play([...START, PRESENT], DEMO_GAME); // 20 s timer, auto lock
    const seq = g.events.at(-1)?.seq ?? 0;
    expect(g.state).toMatchObject({ phase: "open", openedAt: at(g), windowMs: 20_000, timer: { id: seq, endsAt: at(g) + 20_000, durationMs: 20_000, autoLock: true } });
    expect(ok(g, OPEN)).toBe(false); // already open: a separate « open » is refused, never a silent no-op
    const locked = run(reg, [[actor("system"), { type: "timer.expired", timerId: seq }]], g);
    expect(locked.state.phase).toBe("locked");
    expect(replay(locked.session, locked.events, reg).state).toEqual(locked.state);
  });

  it("same opening as a reading round followed by « Ouvrir » (presented and opened by one event)", () => {
    const one = play([...START, PRESENT, answer("p_1", "b")], DEMO_GAME);
    const two = play([...START, PRESENT, OPEN, answer("p_1", "b")], reading(DEMO_GAME));
    expect(seen(one)).toEqual(seen(two));
    expect(project(one, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: ["b"] });
  });

  it("undo of the presentation goes back between questions", () => {
    const g = play([...START, PRESENT, ctl({ type: "undo" })], DEMO_GAME);
    expect(g.state).toMatchObject({ phase: "idle", mechanic: null, timer: null });
  });
});

describe("openOnPresent: false — a reading step", () => {
  it("presenting first, then « Ouvrir les réponses » arms the timer", () => {
    const g = play([...START, PRESENT], reading(DEMO_GAME));
    expect(g.state).toMatchObject({ phase: "presenting", openedAt: null, timer: null });
    expect(ok(g, answer("p_1", "b"))).toBe(false);
    const opened = run(reg, [OPEN], g);
    expect(opened.state).toMatchObject({ phase: "open", timer: { id: opened.events.at(-1)?.seq } });
  });

  it("TV-style buzzer: nobody buzzes while the host reads", () => {
    const buzz: Step = [actor("player", "p_1"), { type: "buzz", participantId: "p_1" }];
    expect(ok(play([...START, PRESENT], reading(DEMO_BUZZER_GAME)), buzz)).toBe(false);
    expect(ok(play([...START, PRESENT, OPEN], reading(DEMO_BUZZER_GAME)), buzz)).toBe(true);
    expect(ok(play([...START, PRESENT], DEMO_BUZZER_GAME), buzz)).toBe(true); // default: buzzers open with the question
  });
});

describe("every mechanic that used the presenting phase still plays when the answers open at once", () => {
  const cases: readonly [string, GameDocument, readonly Step[], Step][] = [
    ["board: the cell chosen, buzzers open", DEMO_BOARD_GAME, [], [actor("player", "p_1"), { type: "buzz", participantId: "p_1" }]],
    ["ladder: a joker before the answer", DEMO_LADDER_GAME, [], ctl({ type: "joker.use", joker: "fifty" })],
    ["chat vote: votes counted", DEMO_CHAT_GAME, [], [actor("system"), { type: "crowd.tally", votes: [{ userId: "tw:1", optionId: "a" }] }]],
    ["survey: the hand, then a spoken answer judged", DEMO_POLL_GAME, [ctl({ type: "poll.control", participantId: "p_1" })], ctl({ type: "answer.judge", correct: false })],
    ["chain: the spoken answer judged", DEMO_CHAIN_GAME, [], ctl({ type: "answer.judge", correct: true })],
    ["hints: an answer with the first hint shown", DEMO_HINTS_GAME, [], [actor("player", "p_1"), { type: "answer.submit", participantId: "p_1", answer: { kind: "text", text: "x" } } satisfies Action]],
  ];
  it.each(cases)("%s", (_name, doc, before, step) => {
    const chain = doc === DEMO_CHAIN_GAME ? [ctl({ type: "player.add", participantId: "p_3", displayName: "J3", channel: "seat" })] : [];
    const roomy = { ...doc, format: { ...doc.format, participants: { max: 10 } } };
    const g = play([...START, ...chain, PRESENT, ...before], roomy);
    expect(g.state.phase).toBe("open");
    expect(ok(g, step)).toBe(true);
    // And with a reading step, after « Ouvrir ».
    const r = play([...START, ...chain, PRESENT, OPEN, ...before], reading(roomy));
    expect(ok(r, step)).toBe(true);
  });

  it("hints: the first hint is shown at the presentation either way", () => {
    for (const doc of [DEMO_HINTS_GAME, reading(DEMO_HINTS_GAME)]) {
      const m = project(play([...START, PRESENT], doc), { role: "output", scene: "program" }, reg).mechanic;
      expect(m?.mechanic === "hints" ? m.hints.length : -1).toBe(1);
    }
  });
});
