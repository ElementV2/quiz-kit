import { describe, expect, it } from "vitest";
import { DEMO_LADDER_GAME, type Action, type GameDocument } from "@quiz/schema";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { teamTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, ctl, makeSession, run } from "../../testing/harness.ts";
import { crowdVote } from "./crowd-vote.ts";

// Six single-choice questions (the ladder demo), played as chat votes.
const CHAT_GAME = (config: Record<string, unknown> = {}): GameDocument => ({
  ...DEMO_LADDER_GAME,
  format: { ...DEMO_LADDER_GAME.format, participants: { mode: "teams", min: 0, max: 50 }, rounds: [{ ...DEMO_LADDER_GAME.format.rounds[0]!, mechanic: "crowd-vote", mechanicConfig: config, timer: undefined }] }, // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
});

// Chat votes come from the server (system actor): the contract checks views, replay and undo around them.
mechanicContractSuite({
  mechanic: crowdVote,
  registry: reg,
  game: CHAT_GAME({ showLive: false, teamId: "t_a", points: 10 }),
  answerFor: () => null,
  controlActor: actor("system"),
  controlActionFor: (_c, picks) => ({ type: "crowd.tally", votes: picks.map((p, i) => ({ userId: `tw:${(p + i) % 7}`, optionId: ["a", "b", "c", "d"][p % 4] ?? "b" })) }),
});

const SYSTEM = actor("system");
const tally = (votes: [string, string][]): readonly [typeof SYSTEM, Action] => [SYSTEM, { type: "crowd.tally", votes: votes.map(([userId, optionId]) => ({ userId, optionId })) }];
const START = [ctl({ type: "team.add", teamId: "t_chat", name: "Le chat", color: "#f0a830" }), ctl({ type: "game.start" }), ctl({ type: "round.start" }), ctl({ type: "question.present" }), ctl({ type: "question.open" })];

describe("crowd-vote", () => {
  it("one vote per viewer (the last one counts), majority revealed, the chat team scores when right", () => {
    let g = run(reg, [...START, tally([["tw:1", "a"], ["tw:2", "b"], ["yt:UCx", "b"]]), tally([["tw:1", "b"], ["tw:9", "zz"]])], createGame(makeSession(CHAT_GAME({ teamId: "t_chat", points: 50 }))));
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ voters: 3, counts: { a: 0, b: 3 }, correct: null, majority: null });
    g = run(reg, [ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ correct: "b", majority: ["b"] });
    expect(teamTotal(g.state, "t_chat")).toBe(50);
  });

  it("stream delay: votes still count right after the lock, not later; tablets never get the distribution", () => {
    // run() spaces steps 1 s apart: with 1500 ms of delay the first vote after the lock counts, the second does not.
    let g = run(reg, [...START, ctl({ type: "question.lock" }), tally([["tw:1", "a"]])], createGame(makeSession(CHAT_GAME({ streamDelayMs: 1500 }))));
    expect(() => run(reg, [tally([["tw:2", "a"]])], g)).toThrow(/wrong-phase/);
    g = run(reg, [ctl({ type: "question.reveal" })], g);
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ voters: 1 });
    expect(project(g, { role: "player", participantId: "p_1" }, reg).mechanic).toMatchObject({ counts: null });
  });

  it("only the server (system) may tally; hidden live counts stay hidden until the reveal", () => {
    const g = run(reg, START, createGame(makeSession(CHAT_GAME({ showLive: false }))));
    expect(() => run(reg, [ctl({ type: "crowd.tally", votes: [{ userId: "tw:1", optionId: "a" }] })], g)).toThrow(/forbidden/);
    const after = run(reg, [tally([["tw:1", "a"]])], g);
    expect(project(after, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ counts: null, voters: 1 });
    expect(project(after, { role: "control" }, reg).mechanic).toMatchObject({ counts: { a: 1 } });
  });
});
