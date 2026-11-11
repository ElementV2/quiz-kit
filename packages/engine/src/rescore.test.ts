import { describe, expect, it } from "vitest";
import { DEMO_GAME, type GameDocument } from "@quiz/schema";
import { createGame, decide, replay, type Game } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { participantTotal, teamTotal } from "./state.ts";
import { answer, ctl, makeSession, run, type Step } from "./testing/harness.ts";

/**
 * Rewriting the points of a revealed question (regrade, forced verdict, way of counting a several-answers QCM) never
 * gives back a line voided by hand, credits the team of the player at the reveal, and keeps the points of a player
 * removed since (their team keeps them). `q_primes`: right answers a and c; 100 points, no decay.
 */

const doc = (mechanic = "mixed"): GameDocument => ({
  ...DEMO_GAME,
  format: { ...DEMO_GAME.format, rounds: [{ id: "r_m", title: "Multi", mechanic, mechanicConfig: {}, questions: ["q_primes"], reserve: [], scoring: [{ type: "base", points: 100 }] }] },
});

const TEAMS: Step[] = [ctl({ type: "team.add", teamId: "t_a", name: "A", color: "#ff0000" }), ctl({ type: "team.add", teamId: "t_b", name: "B", color: "#0000ff" })];
const PLAYERS: Step[] = [1, 2, 3].map((i) => ctl({ type: "player.add", participantId: `p_${i}`, displayName: `J${i}`, teamId: "t_a", channel: "seat" }));
// p_1 exact (100), p_2 one right of two (0 all or nothing, 50 partial), p_3 one right one wrong (0, 50 partial too).
const REVEALED: Step[] = [
  ...TEAMS, ...PLAYERS, ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "question.present" }), 
  answer("p_1", "a", "c"), answer("p_2", "a"), answer("p_3", "a", "b"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }),
];
const partial = ctl({ type: "question.setMultiScoring", questionId: "q_primes", mode: "partial" });
const any = ctl({ type: "question.setMultiScoring", questionId: "q_primes", mode: "any-no-wrong" });
const regradeSame = ctl({ type: "question.regrade", questionId: "q_primes", answerSpec: { kind: "multi", options: [{ id: "a", label: "2" }, { id: "b", label: "9" }, { id: "c", label: "13" }, { id: "d", label: "21" }], correct: ["a", "c"] } });
const verdict = (pid: string, correct: boolean | null): Step => ctl({ type: "answer.verdict", roundIndex: 0, questionIndex: 0, participantId: pid, correct });

const play = (steps: readonly Step[], game: GameDocument = doc()): Game => run(reg, steps, createGame(makeSession(game)));
const pts = (g: Game): number[] => ["p_1", "p_2", "p_3"].map((p) => participantTotal(g.state, p));
const lineOf = (g: Game, pid: string) => g.state.ledger.find((e) => !e.voided && "participantId" in e.target && e.target.participantId === pid);
const voidLine = (g: Game, pid: string): Game => {
  const e = lineOf(g, pid);
  if (e === undefined) throw new Error(`no line for ${pid}`);
  return run(reg, [ctl({ type: "score.void", entryId: e.id })], g);
};

describe("a line voided by hand is never given back by a rewrite", () => {
  it("score.void, then a new way of counting, a regrade, a verdict on someone else", () => {
    const g = voidLine(play(REVEALED), "p_1");
    expect(pts(g)).toEqual([0, 0, 0]);
    const counted = run(reg, [partial], g);
    expect(pts(counted)).toEqual([0, 50, 50]);
    const regraded = run(reg, [regradeSame], counted);
    expect(pts(regraded)).toEqual([0, 50, 50]);
    const other = run(reg, [verdict("p_3", false)], regraded);
    expect(pts(other)).toEqual([0, 50, 0]);
    expect(pts(run(reg, [any], other))).toEqual([0, 100, 0]);
    expect(replay(other.session, other.events, reg).state).toEqual(other.state);
  });

  it("a verdict decided again on that player lifts it (the control room decides anew)", () => {
    const g = run(reg, [verdict("p_1", true)], voidLine(play(REVEALED), "p_1"));
    expect(pts(g)[0]).toBe(100);
  });
  it("taking a forced verdict back (« automatique ») never lifts it; with nothing forced it is refused", () => {
    // Forced ✓, cheating found, line voided by hand, then ✓ clicked again to take the forced verdict back: stays 0.
    const forced = voidLine(play([...REVEALED, verdict("p_2", true)]), "p_2");
    expect(pts(forced)[1]).toBe(0);
    expect(pts(run(reg, [verdict("p_2", null)], forced))[1]).toBe(0);
    expect(() => run(reg, [verdict("p_1", null)], voidLine(play(REVEALED), "p_1"))).toThrow(/aucun verdict forcé/);
  });
});

describe("rewrites credit the team at the reveal", () => {
  it("a player moved to another team since: their new line still goes to their team at the reveal", () => {
    const g = play([...REVEALED, ctl({ type: "player.setTeam", participantId: "p_2", teamId: "t_b" }), partial]);
    // p_2 had no line before (0 all or nothing): the line created by the rewrite goes to team A, not B.
    expect(pts(g)).toEqual([100, 50, 50]);
    expect([teamTotal(g.state, "t_a"), teamTotal(g.state, "t_b")]).toEqual([200, 0]);
  });

  it("a player removed since: their points stay with their team, nothing passes to an id reused later", () => {
    let g = play([...REVEALED, ctl({ type: "player.remove", participantId: "p_1" }), partial]);
    expect(teamTotal(g.state, "t_a")).toBe(200); // p_1's 100 kept + p_2 50 + p_3 50
    g = run(reg, [ctl({ type: "player.add", participantId: "p_1", displayName: "Nouveau", teamId: "t_b", channel: "seat" }), any], g);
    expect(participantTotal(g.state, "p_1")).toBe(100); // the old line, kept as written — the new player gets no new one
    expect(teamTotal(g.state, "t_b")).toBe(0);
    expect(g.state.ledger.filter((e) => !e.voided && "participantId" in e.target && e.target.participantId === "p_1")).toHaveLength(1);
  });
});

describe("player.remove purges forced verdicts", () => {
  it("a verdict on a removed player is refused (their lines are cancelled by hand)", () => {
    const g = play([...REVEALED, ctl({ type: "player.remove", participantId: "p_1" })]);
    expect(() => run(reg, [verdict("p_1", false)], g)).toThrow(/joueur retiré/);
  });

  it("a forced « juste » never passes to a new player reusing the id", () => {
    let g = play([...REVEALED, verdict("p_3", true)]);
    expect(participantTotal(g.state, "p_3")).toBe(100);
    g = run(reg, [ctl({ type: "player.remove", participantId: "p_3" }), ctl({ type: "player.add", participantId: "p_3", displayName: "Autre", channel: "seat" })], g);
    expect(g.state.history[0]?.verdicts).toEqual([]);
    expect(g.state.history[0]?.teamAt).not.toHaveProperty("p_3");
    const before = g.state.ledger.filter((e) => "participantId" in e.target && e.target.participantId === "p_3");
    // A rewrite after: the removed player's line stays as written, the new player gets no line from this question.
    const after = run(reg, [partial], g).state.ledger.filter((e) => "participantId" in e.target && e.target.participantId === "p_3");
    expect(after).toEqual(before);
  });

  it("also on the question on air, before the reveal", () => {
    const g = play([...TEAMS, ...PLAYERS, ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "question.present" }), verdict("p_3", true), ctl({ type: "player.remove", participantId: "p_3" })]);
    expect(g.state.verdicts).toEqual([]);
  });
});

describe("question.setMultiScoring with nothing to change", () => {
  it("is refused when no round plays the question as a QCM", () => {
    const g = play([...TEAMS, ...PLAYERS, ctl({ type: "game.start" })], doc("buzzer"));
    const r = decide(g, { action: { type: "question.setMultiScoring", questionId: "q_primes", mode: "partial" }, actor: { role: "control" }, idempotencyKey: null }, 9_000_000, reg);
    expect(r).toMatchObject({ ok: false, error: { code: "unsupported", message: expect.stringMatching(/aucune manche/) } });
  });
});
