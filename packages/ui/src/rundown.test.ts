import { describe, expect, it } from "vitest";
import type { AnswerSpec, Rundown } from "@quiz/schema";
import { formatAnswer, nextTarget, onAirTarget, questionAt, zoneWords } from "./rundown.ts";

const q = (index: number, id: string, played = false) => ({ index, id, text: `Q ${id}`, played, answerSpec: { kind: "boolean", correct: true } as const, notes: null });
const rundown: Rundown = [
  { index: 0, title: "M1", mechanic: "choice", questions: [q(0, "q_a"), q(1, "q_b")], reserve: [] },
  { index: 1, title: "M2", mechanic: "choice", questions: [q(0, "q_c")], reserve: [] },
  { index: 2, title: "Plateau", mechanic: "board", questions: [q(0, "q_d"), q(1, "q_e")], reserve: [] },
];
const base = { rundown, nextQuestion: null, question: null, round: null, cursor: null } as const;
const round = (index: number) => ({ index, count: 3, title: `M${index + 1}` });
const question = (index: number) => ({ id: "q_x", index, count: 2, prompt: { text: "x" } });

describe("nextTarget", () => {
  it("before the game: the very first question", () => {
    expect(nextTarget({ ...base, phase: "lobby" })).toEqual({ roundIndex: 0, questionIndex: 0 });
  });
  it("follows the engine's nextQuestion", () => {
    expect(nextTarget({ ...base, phase: "idle", round: round(0), nextQuestion: { id: "q_b", text: "" }, cursor: { roundIndex: 0, questionIndex: 0 } })).toEqual({ roundIndex: 0, questionIndex: 1 });
  });
  it("last question revealed: first question of the next round", () => {
    expect(nextTarget({ ...base, phase: "revealed", round: round(0), question: question(1), cursor: { roundIndex: 0, questionIndex: 1 } })).toEqual({ roundIndex: 1, questionIndex: 0 });
  });
  it("round end: next round", () => {
    expect(nextTarget({ ...base, phase: "round.end", round: round(1), cursor: { roundIndex: 1, questionIndex: 0 } })).toEqual({ roundIndex: 2, questionIndex: 0 });
  });
  it("free order (board): nothing to read ahead", () => {
    expect(nextTarget({ ...base, phase: "idle", round: round(2), cursor: { roundIndex: 2, questionIndex: null } })).toBeNull();
  });
  it("game end: nothing", () => {
    expect(nextTarget({ ...base, phase: "game.end", round: round(1) })).toBeNull();
  });
});

describe("onAirTarget / questionAt", () => {
  it("only while a question is on screen", () => {
    expect(onAirTarget({ ...base, phase: "open", round: round(1), question: question(0) })).toEqual({ roundIndex: 1, questionIndex: 0 });
    expect(onAirTarget({ ...base, phase: "idle", round: round(1), question: null })).toBeNull();
    expect(questionAt(rundown, { roundIndex: 1, questionIndex: 0 })?.id).toBe("q_c");
    expect(questionAt(rundown, { roundIndex: 9, questionIndex: 0 })).toBeNull();
  });
});

const f = (s: AnswerSpec) => formatAnswer(s);
describe("formatAnswer", () => {
  it("choices: the right label, options flagged", () => {
    const r = f({ kind: "single", correct: "b", options: [{ id: "a", label: "Lyon" }, { id: "b", label: "Paris" }] });
    expect(r.headline).toBe("Paris");
    expect(r.items.map((i) => i.right)).toEqual([false, true]);
    expect(f({ kind: "multi", correct: ["a", "c"], options: [{ id: "a", label: "2" }, { id: "b", label: "9" }, { id: "c", label: "13" }] }).headline).toBe("2 + 13");
    expect(f({ kind: "boolean", correct: false }).headline).toBe("Faux");
  });
  it("text: canonical first, synonyms as a note", () => {
    expect(f({ kind: "text", accepted: ["Vincent van Gogh", "van gogh"] })).toMatchObject({ headline: "Vincent van Gogh", note: "Aussi accepté : van gogh" });
  });
  it("number: unit and tolerance", () => {
    const r = f({ kind: "number", correct: 8848, tolerance: 100, unit: "m" });
    expect(r.headline.replace(/\s/g, " ")).toBe("8 848 m");
    expect(r.note).toContain("Tolérance ± 100 m");
  });
  it("order, pairs, poll (top first), pin, allocation, oral", () => {
    expect(f({ kind: "order", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] })).toMatchObject({ ordered: true, headline: "A → … → C" });
    expect(f({ kind: "pairs", pairs: [{ id: "1", left: "Paris", right: "France" }, { id: "2", left: "Rome", right: "Italie" }] }).items[1]?.text).toBe("Rome → Italie");
    const poll = f({ kind: "poll", options: [{ id: "a", label: "Pomme", value: 10 }, { id: "b", label: "Banane", value: 40 }] });
    expect(poll.items.map((i) => i.text)).toEqual(["Banane", "Pomme"]);
    expect(poll.items[0]?.value).toBe("40");
    expect(f({ kind: "pin", target: { x: 0.05, y: 0.05, w: 0.1, h: 0.1 } }).headline).toBe("Zone sur l'image, en haut à gauche");
    expect(f({ kind: "allocation", correct: "b", budget: 10000, options: [{ id: "a", label: "Oui" }, { id: "b", label: "Non" }] }).headline).toBe("Non");
    expect(f({ kind: "oral", expected: "Le Kilimandjaro" }).headline).toBe("Le Kilimandjaro");
  });
  it("zoneWords: centre", () => {
    expect(zoneWords({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe("au centre");
  });
});
