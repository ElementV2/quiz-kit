import { describe, expect, it } from "vitest";
import type { HostView } from "@quiz/schema";
import { presentOffer, reading, timecode } from "./logic.ts";

const q = (index: number, id: string) => ({ index, id, text: `Texte ${id}`, played: false, answerSpec: { kind: "boolean", correct: true } as const, notes: null, points: { summary: "", why: "" } });
const view = (over: Partial<HostView>): HostView => ({
  role: "host",
  sessionId: "ses_1",
  phase: "idle",
  round: { index: 0, count: 2, title: "M1" },
  question: null,
  timer: null,
  stakes: null,
  stakesTarget: null,
  gameVersion: 0,
  mechanic: null,
  leaderboard: [],
  layers: {},
  teamBoard: [],
  notes: null,
  nextQuestion: { id: "q_b", text: "Texte q_b" },
  drive: true,
  rundown: [
    { index: 0, title: "M1", mechanic: "choice", questions: [q(0, "q_a"), q(1, "q_b")], reserve: [] },
    { index: 1, title: "M2", mechanic: "choice", questions: [q(0, "q_c")], reserve: [] },
  ],
  cursor: { roundIndex: 0, questionIndex: 0 },
  ...over,
});

describe("reading", () => {
  it("idle: the next question, not on air yet", () => {
    expect(reading(view({}), null)).toMatchObject({ mode: "next", question: { id: "q_b" } });
  });
  it("on air wins over the next one", () => {
    const v = view({ phase: "open", question: { id: "q_b", index: 1, count: 2, prompt: { text: "Texte q_b" } } });
    expect(reading(v, null)).toMatchObject({ mode: "onair", question: { id: "q_b" } });
  });
  it("a picked question is a preview (unless it is the one on air)", () => {
    expect(reading(view({}), { roundIndex: 1, questionIndex: 0 })).toMatchObject({ mode: "preview", question: { id: "q_c" } });
    const v = view({ phase: "open", question: { id: "q_b", index: 1, count: 2, prompt: { text: "x" } } });
    expect(reading(v, { roundIndex: 0, questionIndex: 1 })?.mode).toBe("onair");
  });
});

describe("presentOffer", () => {
  it("same round, idle: present that index", () => {
    expect(presentOffer(view({}), { roundIndex: 0, questionIndex: 1 }, false)).toEqual({ ok: true, label: "Présenter celle-ci", steps: [{ type: "question.present", questionIndex: 1 }], confirm: null });
  });
  it("other round: start it first", () => {
    const o = presentOffer(view({}), { roundIndex: 1, questionIndex: 0 }, false);
    expect(o.ok && o.steps.map((s) => s.type)).toEqual(["round.start", "question.present"]);
  });
  it("lobby: start the game, the round, then present", () => {
    const o = presentOffer(view({ phase: "lobby", round: null }), { roundIndex: 0, questionIndex: 0 }, false);
    expect(o.ok && o.steps.map((s) => s.type)).toEqual(["game.start", "round.start", "question.present"]);
  });
  it("played question asks for a confirmation", () => {
    const o = presentOffer(view({}), { roundIndex: 0, questionIndex: 0 }, true);
    expect(o.ok && o.confirm).toBe("Déjà jouée : la rejouer ?");
  });
  it("refused: control drives, a question on air, game over", () => {
    expect(presentOffer(view({ drive: false }), { roundIndex: 0, questionIndex: 1 }, false).ok).toBe(false);
    expect(presentOffer(view({ phase: "open", question: { id: "q_a", index: 0, count: 2, prompt: { text: "x" } } }), { roundIndex: 0, questionIndex: 1 }, false).ok).toBe(false);
    expect(presentOffer(view({ phase: "game.end" }), { roundIndex: 0, questionIndex: 1 }, false).ok).toBe(false);
  });
});

it("timecode", () => {
  expect(timecode(7.9)).toBe("0:07");
  expect(timecode(90)).toBe("1:30");
  expect(timecode(-3)).toBe("0:00");
});
