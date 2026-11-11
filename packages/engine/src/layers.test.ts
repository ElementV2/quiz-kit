import { describe, expect, it } from "vitest";
import { decide } from "./game.ts";
import { defaultRegistry as reg } from "./index.ts";
import { project } from "./project.ts";
import { actor, CONTROL, ctl, run } from "./testing/harness.ts";

describe("layers TAKE / OUT (doc 06)", () => {
  it("control takes a manual layer on air and off, visible in every view, undoable", () => {
    let g = run(reg, [ctl({ type: "layer.take", layerId: "lower-third" })]);
    expect(project(g, { role: "output", scene: "program" }, reg).layers).toEqual({ "lower-third": true });
    g = run(reg, [ctl({ type: "layer.out", layerId: "lower-third" })], g);
    expect(project(g, { role: "player", participantId: "p_1" }, reg).layers).toEqual({ "lower-third": false });
    g = run(reg, [ctl({ type: "undo" })], g);
    expect(g.state.layers).toEqual({ "lower-third": true });
  });

  it("refuses a double TAKE / OUT and players cannot touch layers", () => {
    const g = run(reg, [ctl({ type: "layer.take", layerId: "x" })]);
    expect(decide(g, { action: { type: "layer.take", layerId: "x" }, actor: CONTROL, idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(decide(g, { action: { type: "layer.out", layerId: "x" }, actor: actor("player", "p_1"), idempotencyKey: null }, 9e9, reg)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
