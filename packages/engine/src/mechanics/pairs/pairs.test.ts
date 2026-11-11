import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { DEMO_PAIRS_GAME, type Action } from "@quiz/schema";
import { pairs } from "./pairs.ts";

const rotate = <T,>(xs: readonly T[], n: number): T[] => xs.map((_, i) => xs[(i + n) % xs.length]).filter((x) => x !== undefined);

mechanicContractSuite({
  mechanic: pairs,
  registry: reg,
  game: DEMO_PAIRS_GAME,
  answerFor: (_v, picks, pid, control): Action | null => {
    const m = control.mechanic;
    if (m?.mechanic !== "pairs" || m.correct === null) return null;
    const rights = rotate(m.correct.map((c) => c.right), (picks[0] ?? 0) % 2 === 0 ? 0 : (picks[1] ?? 1));
    return { type: "answer.submit", participantId: pid, answer: { kind: "pairs", matches: m.correct.map((c, i) => ({ left: c.left, right: rights[i] ?? c.right })) } };
  },
  // Right column ids are anonymous: the id never tells which left item it matches.
  assertNoLeak: (v) => {
    const m = v.mechanic;
    if (m?.mechanic === "pairs" && !m.right.every((r) => /^r\d+$/.test(r.id))) throw new Error("right ids must be anonymous");
  },
});

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" }), ctl({ type: "question.open" })];
const submitPairs = (pid: string, matches: { left: string; right: string }[]) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "pairs", matches } }] as const;

describe("pairs", () => {
  it("needs every pair, once, and scores only a full match", () => {
    const g = run(reg, OPEN, createGame(makeSession(DEMO_PAIRS_GAME)));
    const c = project(g, { role: "control" }, reg).mechanic;
    if (c?.mechanic !== "pairs" || c.correct === null) throw new Error("pairs view");
    const right = c.correct;
    expect(() => run(reg, [submitPairs("p_1", right.slice(0, 3))], g)).toThrow(/invalid/);
    const swapped = right.map((m, i) => (i < 2 ? { left: m.left, right: right[1 - i]?.right ?? m.right } : m));
    const done = run(reg, [submitPairs("p_1", right.toReversed()), submitPairs("p_2", swapped), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(done.state, "p_1")).toBeGreaterThan(0);
    expect(participantTotal(done.state, "p_2")).toBe(0);
    expect(project(done, { role: "player", participantId: "p_1" }, reg)).toMatchObject({ myAnswer: expect.any(Array) });
  });
});
