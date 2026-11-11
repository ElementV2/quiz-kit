import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import type { Action, GameDocument } from "@quiz/schema";
import { pin } from "./pin.ts";

const MAP = { hash: "a".repeat(64), mime: "image/png", w: 1600, h: 900 };

const PIN_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Pin",
  scenes: [],
  questions: [
    { id: "q_pin_1", prompt: { text: "Où est Paris ?", media: MAP }, answerSpec: { kind: "pin", target: { x: 0.4, y: 0.3, w: 0.1, h: 0.1 } }, hints: [], tags: [], notes: "secret-pin-1" },
    { id: "q_pin_2", prompt: { text: "Où est Lyon ?", media: MAP }, answerSpec: { kind: "pin", target: { x: 0.6, y: 0.6, w: 0.05, h: 0.05 } }, hints: [], tags: [], notes: "secret-pin-2" },
  ],
  format: { id: "f_pin", name: "Pin", participants: { max: 50 }, tieBreak: "speed", rounds: [{ id: "r_pin", title: "Carte", mechanic: "pin", mechanicConfig: {}, questions: ["q_pin_1", "q_pin_2"], reserve: [], scoring: [{ type: "base", points: 100 }] }] },
};

mechanicContractSuite({
  mechanic: pin,
  registry: reg,
  game: PIN_GAME,
  answerFor: (_v, picks, pid, control): Action | null => {
    const t = control.mechanic?.mechanic === "pin" ? control.mechanic.correct : null;
    if (t === null || t === undefined) return null;
    const hit = (picks[0] ?? 0) % 2 === 0;
    return { type: "answer.submit", participantId: pid, answer: { kind: "pin", x: hit ? t.x + t.w / 2 : 0.01, y: hit ? t.y + t.h / 2 : 0.99 } };
  },
  // Pins are anonymous: never who placed them.
  assertNoLeak: (v) => {
    if (v.mechanic?.mechanic === "pin" && v.mechanic.pins !== null && JSON.stringify(v.mechanic.pins).includes("p_")) throw new Error("pin owner leaked");
  },
});

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(2), ctl({ type: "question.present" })];

const tap = (pid: string, x: number, y: number) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "pin", x, y } }] as const;

describe("pin", () => {
  it("is right inside the target zone, shows anonymous pins at reveal", () => {
    const g = run(reg, [...OPEN, tap("p_1", 0.45, 0.35), tap("p_2", 0.9, 0.9), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], createGame(makeSession(PIN_GAME)));
    expect(participantTotal(g.state, "p_1")).toBe(100);
    expect(participantTotal(g.state, "p_2")).toBe(0);
    expect(project(g, { role: "output", scene: "program" }, reg).mechanic).toMatchObject({ correct: { x: 0.4 }, pins: [{ x: 0.45, y: 0.35, hit: true }, { x: 0.9, y: 0.9, hit: false }] });
  });
});
