import { describe, expect, it } from "vitest";
import { createGame, decide, defaultRegistry, project, type Game } from "@quiz/engine";
import { DEMO_CHAIN_GAME, type Action, type ControlView } from "@quiz/schema";
import { planCommand } from "./commands.ts";

/** Companion / OSC / HTTP `next` during « La chaîne »: the same key as the control room (never open / lock / reveal). */
function play(actions: readonly Action[]): ControlView {
  let g: Game = createGame({ schemaVersion: 1, id: "ses_cmd", game: DEMO_CHAIN_GAME, seed: 1, createdAt: 0 });
  let at = 1_000_000;
  for (const action of actions) {
    at += 1000;
    const r = decide(g, { action, actor: { role: "control", id: "test" }, idempotencyKey: null }, at, defaultRegistry);
    if (!r.ok) throw new Error(`${action.type}: ${r.error.message}`);
    g = r.value.game;
  }
  const v = project(g, { role: "control" }, defaultRegistry);
  if (v.role !== "control") throw new Error("control view expected");
  return v;
}

const players: Action[] = ["Ana", "Bo", "Cy"].map((displayName, i) => ({ type: "player.add", participantId: `p_${i + 1}`, displayName, seat: i + 1, channel: "seat" }));
const onAir: Action[] = [...players, { type: "game.start" }, { type: "round.start" }, { type: "question.present" }];

describe("next command — « La chaîne »", () => {
  it("refuses with the reason until the answer is judged, then goes to the next question", () => {
    expect(planCommand("next", [], play(onAir), 0)).toEqual({ error: "D'abord : Juste ou Faux" });
    expect(planCommand("next", [], play([...onAir, { type: "answer.judge", correct: true }]), 0)).toEqual({ action: { type: "question.next" }, label: "Question suivante" });
  });

  it("time up: ends the round, then opens the elimination vote", () => {
    const ended: Action[] = [...onAir, { type: "answer.judge", correct: true }, { type: "chain.end" }];
    expect(planCommand("next", [], play(ended), 0)).toEqual({ action: { type: "question.next" }, label: "Fin de la manche" });
    expect(planCommand("next", [], play([...ended, { type: "question.next" }]), 0)).toEqual({ action: { type: "chain.openVote" }, label: "Ouvrir le vote d'élimination" });
  });
});
