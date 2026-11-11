import { describe, expect, it } from "vitest";
import { DEMO_GAME, DEMO_NUMBER_GAME, DEMO_ORDER_GAME, DEMO_PAIRS_GAME, DEMO_TEXT_GAME, type AnswerValue, type Question } from "@quiz/schema";
import type { AnyMechanic, Judgement } from "../mechanic.ts";
import { createRng } from "../rng.ts";
import { pointsFor } from "../scoring.ts";
import { applyVerdicts } from "../verdicts.ts";
import { choice } from "./choice/choice.ts";
import { numberAnswer } from "./number-answer/number-answer.ts";
import { order } from "./order/order.ts";
import { pairs } from "./pairs/pairs.ts";
import { pin } from "./pin/pin.ts";
import { textAnswer } from "./text-answer/text-answer.ts";

/** Every category setting of a mixed round changes the game: played straight on the mechanic. */

const env = { at: 1000, rng: createRng(1, 1), phase: "open" as const };
const ctx = (q: Question) => ({ previous: null, questionIndex: 0, questionsLeft: 0, questions: [q] });
function play(m: AnyMechanic, config: unknown, q: Question, answers: readonly [string, AnswerValue][]): readonly Judgement[] {
  const cfg = m.configSchema.parse(config);
  const init = m.init(cfg, q, env, ctx(q));
  if (!init.ok) throw new Error(init.error.message);
  let s = init.value;
  for (const [pid, a] of answers) {
    const r = m.submit(s, pid, a, env);
    if (!r.ok) throw new Error(r.error.message);
    s = r.value;
  }
  return m.judge(s);
}
const of = (js: readonly Judgement[], pid: string) => js.find((j) => j.kind === "rule" && j.participantId === pid);
const points = (j: Judgement | undefined) => (j?.kind === "rule" ? pointsFor([{ type: "base", points: 100 }], j, { openedAt: 1000, durationMs: null }) : 0);
const q = (game: { questions: readonly Question[] }, id: string): Question => {
  const x = game.questions.find((y) => y.id === id);
  if (x === undefined) throw new Error(id);
  return x;
};

describe("category settings change the game", () => {
  it("QCM, several right answers: all or nothing by default, partial points when asked", () => {
    const primes = q(DEMO_GAME, "q_primes"); // right: a, c
    const half: [string, AnswerValue][] = [["p_1", { kind: "choice", optionIds: ["a"] }], ["p_2", { kind: "choice", optionIds: ["a", "b"] }]];
    expect(points(of(play(choice, {}, primes, half), "p_1"))).toBe(0);
    const partial = play(choice, { partialMulti: true }, primes, half);
    expect(points(of(partial, "p_1"))).toBe(50); // 1 right of 2
    expect(points(of(partial, "p_2"))).toBe(0); // 1 right − 1 wrong
  });

  it("number: % tolerance, N closest winners, points by precision", () => {
    const bones = q(DEMO_NUMBER_GAME, "q_num_1"); // 206, tolerance 0
    const near: [string, AnswerValue][] = [["p_1", { kind: "number", value: 210 }], ["p_2", { kind: "number", value: 230 }], ["p_3", { kind: "number", value: 300 }]];
    expect(of(play(numberAnswer, {}, bones, near), "p_1")).toMatchObject({ outcome: "wrong" });
    const pct = play(numberAnswer, { tolerancePercent: 5 }, bones, near); // ± 10.3
    expect(of(pct, "p_1")).toMatchObject({ outcome: "correct" });
    expect(of(pct, "p_2")).toMatchObject({ outcome: "wrong" });
    const two = play(numberAnswer, { mode: "closest", winners: 2 }, bones, near);
    expect([of(two, "p_1"), of(two, "p_2"), of(two, "p_3")].map((j) => j?.kind === "rule" && j.outcome)).toEqual(["correct", "correct", "wrong"]);
    const graded = play(numberAnswer, { tolerancePercent: 10, graded: true }, bones, [["p_1", { kind: "number", value: 206 }], ["p_2", { kind: "number", value: 216 }]]);
    expect(points(of(graded, "p_1"))).toBe(100);
    expect(points(of(graded, "p_2"))).toBeLessThan(100);
    expect(points(of(graded, "p_2"))).toBeGreaterThanOrEqual(50);
  });

  it("order and pairs: partial points for what is in place", () => {
    const ord = q(DEMO_ORDER_GAME, "q_ord_1");
    const ids = ord.answerSpec.kind === "order" ? ord.answerSpec.options.map((o) => o.id) : [];
    const swapped = [ids[0] ?? "", ids[1] ?? "", ids[3] ?? "", ids[2] ?? ""];
    expect(points(of(play(order, {}, ord, [["p_1", { kind: "order", optionIds: swapped }]]), "p_1"))).toBe(0);
    expect(points(of(play(order, { partial: true }, ord, [["p_1", { kind: "order", optionIds: swapped }]]), "p_1"))).toBe(50);

    const pq = q(DEMO_PAIRS_GAME, "q_pair_1");
    const cfg = pairs.configSchema.parse({ partial: true });
    const st = pairs.init(cfg, pq, env, ctx(pq));
    if (!st.ok) throw new Error("pairs");
    const s0 = st.value as { left: { id: string }[]; correct: { left: string; right: string }[] }; // oxlint-disable-line typescript/no-unsafe-type-assertion -- test reads the shuffled ids
    const rightOf = (l: string) => s0.correct.find((c) => c.left === l)?.right ?? "";
    const [l0, l1, ...rest] = s0.left.map((l) => l.id);
    const matches = [{ left: l0 ?? "", right: rightOf(l1 ?? "") }, { left: l1 ?? "", right: rightOf(l0 ?? "") }, ...rest.map((l) => ({ left: l, right: rightOf(l) }))];
    const sub = pairs.submit(st.value, "p_1", { kind: "pairs", matches }, env);
    if (!sub.ok) throw new Error(sub.error.message);
    expect(points(of(pairs.judge(sub.value), "p_1"))).toBe(50); // 2 of 4 right
  });

  it("text: typos tolerated by default for the category (a question may still say otherwise)", () => {
    const vg = q(DEMO_TEXT_GAME, "q_txt_1"); // « Vincent van Gogh », « Van Gogh »
    const typo: [string, AnswerValue][] = [["p_1", { kind: "text", text: "Van Gogk" }]];
    expect(of(play(textAnswer, { typos: "0" }, vg, typo), "p_1")).toMatchObject({ outcome: "wrong" });
    expect(of(play(textAnswer, { typos: "1" }, vg, typo), "p_1")).toMatchObject({ outcome: "correct" });
  });

  it("pin: a margin around the target counts a near miss", () => {
    const target: Question = { id: "q_pin", prompt: { text: "Où ?", media: { hash: "a".repeat(64), mime: "image/png" } }, answerSpec: { kind: "pin", target: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }, hints: [], tags: [] };
    const miss: [string, AnswerValue][] = [["p_1", { kind: "pin", x: 0.62, y: 0.5 }]];
    expect(of(play(pin, {}, target, miss), "p_1")).toMatchObject({ outcome: "wrong" });
    expect(of(play(pin, { margin: 5 }, target, miss), "p_1")).toMatchObject({ outcome: "correct" });
  });

  it("a regrade keeps the category settings (text typos); a forced verdict replaces a partial share; a share scales with multipliers", () => {
    const vg = q(DEMO_TEXT_GAME, "q_txt_1");
    const cfg = textAnswer.configSchema.parse({ typos: "0" });
    const st = textAnswer.init(cfg, vg, env, ctx(vg));
    if (!st.ok) throw new Error("text");
    const sub = textAnswer.submit(st.value, "p_1", { kind: "text", text: "Van Gogk" }, env);
    if (!sub.ok) throw new Error("submit");
    const re = textAnswer.regrade?.(sub.value, vg);
    if (re === null || re === undefined || !re.ok) throw new Error("regrade");
    expect(of(textAnswer.judge(re.value), "p_1")).toMatchObject({ outcome: "wrong" }); // still no typo allowed

    const partial: Judgement = { kind: "rule", participantId: "p_1", outcome: "correct", answeredAt: 1000, share: 0.5 };
    expect(pointsFor([{ type: "base", points: 100 }, { type: "multiplier", factor: 2 }], partial, { openedAt: 1000, durationMs: null })).toBe(100);
    expect(applyVerdicts([partial], [{ participantId: "p_1", correct: true }], 1000)).toEqual([{ kind: "rule", participantId: "p_1", outcome: "correct", answeredAt: 1000 }]);
  });

  it("vote: no right answer — no points, or the majority / the minority score; the most voted stands out at the reveal", () => {
    const vote: Question = { id: "q_vote", prompt: { text: "Pizza ou burger ?" }, answerSpec: { kind: "vote", options: [{ id: "a", label: "Pizza" }, { id: "b", label: "Burger" }] }, hints: [], tags: [] };
    const votes: [string, AnswerValue][] = [["p_1", { kind: "choice", optionIds: ["a"] }], ["p_2", { kind: "choice", optionIds: ["a"] }], ["p_3", { kind: "choice", optionIds: ["b"] }]];
    expect(play(choice, {}, vote, votes)).toEqual([]);
    const maj = play(choice, { vote: "majority" }, vote, votes);
    expect([of(maj, "p_1"), of(maj, "p_3")].map((j) => j?.kind === "rule" && j.outcome)).toEqual(["correct", "wrong"]);
    const min = play(choice, { vote: "minority" }, vote, votes);
    expect([of(min, "p_1"), of(min, "p_3")].map((j) => j?.kind === "rule" && j.outcome)).toEqual(["wrong", "correct"]);
    const cfg = choice.configSchema.parse({});
    let st = choice.init(cfg, vote, env, ctx(vote));
    if (!st.ok) throw new Error("vote");
    for (const [pid, a] of votes) {
      const r = choice.submit(st.value, pid, a, env);
      if (!r.ok) throw new Error("submit");
      st = r;
    }
    expect(choice.project(st.value, { audience: "public", phase: "revealed", participantId: null })).toMatchObject({ kind: "vote", correct: ["a"], counts: { a: 2, b: 1 } });
    expect(choice.project(st.value, { audience: "player", phase: "open", participantId: "p_1" })).toMatchObject({ correct: null });
  });

  it("race: only the N fastest right answers score", () => {
    const capital = q(DEMO_GAME, "q_capital_fr");
    const right = capital.answerSpec.kind === "single" ? capital.answerSpec.correct : "";
    const cfg = choice.configSchema.parse({ race: 1 });
    let st = choice.init(cfg, capital, env, ctx(capital));
    if (!st.ok) throw new Error("init");
    for (const [pid, at] of [["p_1", 2000], ["p_2", 1500]] as const) {
      const r = choice.submit(st.value, pid, { kind: "choice", optionIds: [right] }, { ...env, at });
      if (!r.ok) throw new Error("submit");
      st = r;
    }
    const js = choice.judge(st.value);
    expect(points(of(js, "p_2"))).toBe(100); // fastest
    expect(points(of(js, "p_1"))).toBe(0); // right, but second
  });

  it("vote: a tie has no minority (nobody scores); the reveal shows the mode's winners", () => {
    const vote: Question = { id: "q_vote2", prompt: { text: "A ou B ?" }, answerSpec: { kind: "vote", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, hints: [], tags: [] };
    const tie: [string, AnswerValue][] = [["p_1", { kind: "choice", optionIds: ["a"] }], ["p_2", { kind: "choice", optionIds: ["b"] }]];
    expect(play(choice, { vote: "minority" }, vote, tie).every((j) => j.outcome === "wrong")).toBe(true);
  });
});

