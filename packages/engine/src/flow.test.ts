import { describe, expect, it } from "vitest";
import { DEMO_TEXT_GAME, Format, type GameDocument } from "@quiz/schema";
import { createGame } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { nextRoundIndex } from "./reduce.ts";
import { actor, addPlayers, ctl, makeSession, run } from "./testing/harness.ts";

// Three rounds of one question: main → (tie ? barrage : final) ; barrage loops on itself while tied → final → end.
const round = (id: string, q: string) => ({ ...DEMO_TEXT_GAME.format.rounds[0]!, id, title: id, questions: [q], timer: undefined, scoring: [{ type: "base" as const, points: 100 }] }); // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
const FLOW_GAME: GameDocument = {
  ...DEMO_TEXT_GAME,
  format: {
    ...DEMO_TEXT_GAME.format,
    rounds: [round("r_main", "q_txt_1"), round("r_final", "q_txt_2"), round("r_barrage", "q_txt_3")],
    flow: [
      { from: "r_main", to: "r_barrage", when: "tie" },
      { from: "r_main", to: "r_final", when: "always" },
      { from: "r_barrage", to: "r_barrage", when: "tie" },
      { from: "r_barrage", to: "r_final", when: "no-tie" },
      { from: "r_final", to: "end", when: "always" },
    ],
  },
};
const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;
const play = (answers: (readonly [ReturnType<typeof actor>, never])[] | ReturnType<typeof say>[]) => [ctl({ type: "question.present" }), ...answers, ctl({ type: "question.lock" }), ctl({ type: "question.reveal" }), ctl({ type: "question.next" })];

describe("format flow", () => {
  it("validates transitions against the rounds", () => {
    expect(Format.safeParse({ ...FLOW_GAME.format, flow: [{ from: "r_nope", to: "end" }] }).success).toBe(false);
    expect(Format.safeParse(FLOW_GAME.format).success).toBe(true);
  });

  it("a tie sends to the barrage, which loops until the tie is broken, then the final, then the end", () => {
    let g = run(reg, [ctl({ type: "game.start" }), ...addPlayers(2), ctl({ type: "round.start" })], createGame(makeSession(FLOW_GAME)));
    // Main round: both right → tie.
    g = run(reg, play([say("p_1", "Van Gogh"), say("p_2", "Van Gogh")]), g);
    expect(g.state.phase).toBe("round.end");
    expect(nextRoundIndex(g.state)).toBe(2);
    g = run(reg, [ctl({ type: "round.start" })], g);
    expect(g.state.roundIndex).toBe(2);
    // Barrage: both wrong → still tied → barrage again.
    g = run(reg, play([say("p_1", "1788"), say("p_2", "1790")]), g);
    expect(nextRoundIndex(g.state)).toBe(2);
    g = run(reg, [ctl({ type: "round.start" }), ...play([say("p_1", "1789")])], g);
    // Tie broken → final, and the final ends the game (phase game.end straight away).
    expect(nextRoundIndex(g.state)).toBe(1);
    g = run(reg, [ctl({ type: "round.start" }), ...play([])], g);
    expect(g.state.phase).toBe("game.end");
  });

  it("without transitions the list order applies, as before", () => {
    const g = run(reg, [ctl({ type: "game.start" }), ...addPlayers(1), ctl({ type: "round.start" })], createGame(makeSession({ ...FLOW_GAME, format: { ...FLOW_GAME.format, flow: [] } })));
    expect(nextRoundIndex(g.state)).toBe(1);
  });
});
