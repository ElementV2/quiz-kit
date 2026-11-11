import { describe, expect, it } from "vitest";
import { createGame } from "../../game.ts";
import { defaultRegistry as reg } from "../../index.ts";
import { project } from "../../project.ts";
import { participantTotal } from "../../state.ts";
import { mechanicContractSuite } from "../../testing/contract-suite.ts";
import { actor, addPlayers, ctl, makeSession, run } from "../../testing/harness.ts";
import { DEMO_HINTS_GAME, type GameDocument } from "@quiz/schema";
import { progressiveAnswer, revealNext } from "../shared/progressive.testing.ts";
import { revealImage } from "./reveal-image.ts";

const PHOTO = { hash: "b".repeat(64), mime: "image/jpeg", w: 1920, h: 1080 };
const IMAGE_GAME: GameDocument = {
  ...DEMO_HINTS_GAME,
  questions: DEMO_HINTS_GAME.questions.map((q) => ({ ...q, prompt: { ...q.prompt, media: PHOTO } })),
  format: { ...DEMO_HINTS_GAME.format, rounds: DEMO_HINTS_GAME.format.rounds.map((r) => ({ ...r, mechanic: "reveal-image", mechanicConfig: { cols: 3, rows: 2 } })) },
};

mechanicContractSuite({
  mechanic: revealImage,
  registry: reg,
  game: IMAGE_GAME,
  answerFor: (_v, picks, pid, control) => (control.mechanic?.mechanic === "reveal-image" ? progressiveAnswer(picks, pid, control.mechanic) : null),
  controlActionFor: revealNext,
  // The tablets never get the picture (neither in the mechanic view nor in the question prompt).
  assertNoLeak: (v) => {
    if (v.role === "player" && v.mechanic?.mechanic === "reveal-image" && JSON.stringify(v).includes(PHOTO.hash)) throw new Error("picture sent to a tablet");
  },
});

const OPEN = [ctl({ type: "game.start" }), ctl({ type: "round.start" }), ...addPlayers(3), ctl({ type: "question.present" })];
const say = (pid: string, text: string) => [actor("player", pid), { type: "answer.submit", participantId: pid, answer: { kind: "text", text } }] as const;

describe("reveal-image", () => {
  it("uncovers tiles in a seeded order, the output gets the image, the tablet never", () => {
    let g = run(reg, OPEN, createGame(makeSession(IMAGE_GAME)));
    const out = project(g, { role: "output", scene: "program" }, reg);
    expect(out.mechanic).toMatchObject({ mechanic: "reveal-image", cols: 3, rows: 2, image: PHOTO, points: 100 });
    expect(out.question?.prompt.media).toEqual(PHOTO);
    const tablet = project(g, { role: "player", participantId: "p_1" }, reg);
    expect(tablet.question?.prompt.media).toBeUndefined();
    expect(tablet.mechanic).toMatchObject({ image: null });
    g = run(reg, [ctl({ type: "element.reveal", index: 1 })], g);
    const m = project(g, { role: "output", scene: "program" }, reg).mechanic;
    expect(m?.mechanic === "reveal-image" ? m.revealed.length : 0).toBe(2);
    g = run(reg, [say("p_1", "Marie Curie"), ctl({ type: "question.lock" }), ctl({ type: "question.reveal" })], g);
    expect(participantTotal(g.state, "p_1")).toBe(82);
    const end = project(g, { role: "output", scene: "program" }, reg).mechanic;
    expect(end?.mechanic === "reveal-image" ? end.revealed.length : 0).toBe(6);
  });
});
