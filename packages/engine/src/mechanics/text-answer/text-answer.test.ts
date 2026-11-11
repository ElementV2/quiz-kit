import { describe, expect, it } from "vitest";
import { DEMO_TEXT_GAME, type Action, type View } from "@quiz/schema";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { createGame } from "../../game.ts";
import { editDistance, matchesText, normalizeAnswer } from "../shared/text-match.ts";
import { textAnswer } from "./text-answer.ts";

const GUESSES = ["Van Gogh", "van gog", "Canberra", "Sydney", "1789", "1788", "Picasso"];

mechanicContractSuite({
  mechanic: textAnswer,
  registry: reg,
  game: DEMO_TEXT_GAME,
  answerFor: (_v: View, picks, pid, control): Action => {
    const m = control.mechanic;
    const right = m?.mechanic === "text-answer" ? m.correct : null;
    const pick = picks[0] ?? 0;
    const text = pick % 2 === 0 && right !== null ? right : (GUESSES[pick % GUESSES.length] ?? "x");
    return { type: "answer.submit", participantId: pid, answer: { kind: "text", text } };
  },
  controlActionFor: (control, picks): Action | null => {
    const a = control.answers[(picks[0] ?? 0) % Math.max(control.answers.length, 1)];
    return a === undefined ? null : { type: "answer.judge", participantId: a.participantId, correct: (picks[1] ?? 0) % 2 === 0 };
  },
});

const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;
const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3), ctl({ type: "question.present" })];
const g0 = () => createGame(makeSession(DEMO_TEXT_GAME));

describe("fuzzy matching", () => {
  it("ignores case, accents, punctuation and leading articles", () => {
    expect(normalizeAnswer("  L'Élysée !! ")).toBe("elysee");
    expect(normalizeAnswer("Les")).toBe("les");
    expect(matchesText("la tour eiffel", { accepted: ["Tour Eiffel"] })).toBe(true);
    expect(matchesText("Cœur", { accepted: ["coeur"] })).toBe(true);
  });

  it("tolerates typos by length, never on numbers", () => {
    expect(editDistance("canbera", "canberra", 2)).toBe(1);
    expect(matchesText("Canbera", { accepted: ["Canberra"] })).toBe(true);
    expect(matchesText("Rome", { accepted: ["Lima"] })).toBe(false);
    expect(matchesText("Lyma", { accepted: ["Lima"] })).toBe(false); // ≤ 4 letters: exact
    expect(matchesText("1788", { accepted: ["1789"] })).toBe(false);
    expect(matchesText("Canbera", { accepted: ["Canberra"], maxDistance: 0 })).toBe(false);
  });
});

describe("text-answer", () => {
  it("scores fuzzy-right answers and hides the answer until reveal", () => {
    let g = run(reg, [...OPEN, say("p_1", "van gog"), say("p_2", "Monet")], g0());
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: ["van gog"], mechanic: { correct: null, review: null } });
    expect(JSON.stringify(project(g, { role: "output", scene: "program" }, reg))).not.toContain("Vincent");
    expect(project(g, { role: "control" }, reg).mechanic).toMatchObject({ review: [{ participantId: "p_1", accepted: true }, { participantId: "p_2", accepted: false }] });
    g = run(reg, [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(project(g, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myResult: "correct", mechanic: { correct: "Vincent van Gogh" } });
    expect(project(g, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myResult: "wrong" });
  });

  it("lets the operator overrule a verdict before the reveal only", () => {
    let g = run(reg, [...OPEN, say("p_2", "Vincent"), ctl({ type: "question.lock" }), ctl({ type: "answer.judge", participantId: "p_2", correct: true })], g0());
    expect(project(g, { role: "control" }, reg).mechanic).toMatchObject({ review: [{ participantId: "p_2", accepted: true, overruled: true }] });
    g = run(reg, [ctl({ type: "question.reveal" })], g);
    expect(project(g, { role: "player", participantId: "p_2" }, reg)).toMatchObject({ myResult: "correct" });
    expect(() => run(reg, [ctl({ type: "answer.judge", participantId: "p_2", correct: false })], g)).toThrow(/wrong-phase/);
    expect(() => run(reg, [...OPEN, ctl({ type: "answer.judge", participantId: "p_3", correct: true })], g0())).toThrow(/not-found/);
  });

  it("refuses a choice answer", () => {
    const g = run(reg, OPEN, g0());
    expect(() => run(reg, [[actor("player", "p_1"), { type: "answer.submit", participantId: "p_1", answer: { kind: "choice", optionIds: ["a"] } }]], g)).toThrow(/invalid/);
  });
});
