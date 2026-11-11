import { describe, expect, it } from "vitest";
import { createGame, decide, defaultRegistry, replay, type Game } from "@quiz/engine";
import { DEMO_GAME, type Action, type Actor } from "@quiz/schema";
import { actorLabel, createReplayCursor } from "./replay-logic.ts";

const CTL: Actor = { role: "control", id: "op" };

/** A journal with answers, scores and undos (some crossing checkpoints). */
function journal(): Game {
  let g = createGame({ schemaVersion: 1, id: "ses_replay", game: DEMO_GAME, seed: 7, createdAt: 0 });
  let at = 1_000;
  const step = (action: Action, actor: Actor = CTL) => {
    at += 500;
    const r = decide(g, { action, actor, idempotencyKey: null }, at, defaultRegistry);
    if (r.ok) g = r.value.game;
  };
  step({ type: "player.add", participantId: "p_a", displayName: "A", seat: 1, channel: "seat" });
  step({ type: "player.add", participantId: "p_b", displayName: "B", seat: 2, channel: "seat" });
  step({ type: "game.start" });
  step({ type: "round.start" });
  for (let i = 0; i < 12; i++) {
    step({ type: "score.adjust", target: { participantId: i % 2 === 0 ? "p_a" : "p_b" }, delta: 10 + i, reason: "bonus" });
    if (i % 4 === 3) step({ type: "undo" });
  }
  step({ type: "undo", targetSeq: 5 }); // crosses every small checkpoint
  step({ type: "question.present", questionIndex: 0 });
  // The presentation opens the answers (round default).
  step({ type: "answer.submit", participantId: "p_a", answer: { kind: "choice", optionIds: ["b"] } }, { role: "player", id: "p_a" });
  step({ type: "question.lock" });
  step({ type: "question.reveal" });
  return g;
}

describe("createReplayCursor", () => {
  it("gives the same state as a full replay of the prefix, in any visiting order", () => {
    const g = journal();
    const n = g.events.length;
    expect(n).toBeGreaterThan(20);
    const cursor = createReplayCursor(g.session, g.events, defaultRegistry, 4);
    const order = [n, 3, 0, 17, 16, 18, 9, n - 1, 1, 12, 8, n, 5];
    for (const k of order) {
      expect(cursor.at(k).state, `k=${k}`).toEqual(replay(g.session, g.events.slice(0, k), defaultRegistry).state);
    }
    for (let k = 0; k <= n; k++) expect(cursor.at(k).state, `k=${k}`).toEqual(replay(g.session, g.events.slice(0, k), defaultRegistry).state);
  });
  it("clamps the step", () => {
    const g = journal();
    const cursor = createReplayCursor(g.session, g.events, defaultRegistry);
    expect(cursor.at(-3).state.lastSeq).toBe(0);
    expect(cursor.at(10_000).state).toEqual(g.state);
  });
  it("labels actors in French", () => {
    expect(actorLabel({ actor: { role: "player", id: "p_a" } })).toBe("joueur p_a");
    expect(actorLabel({ actor: { role: "control" } })).toBe("régie");
  });
});
