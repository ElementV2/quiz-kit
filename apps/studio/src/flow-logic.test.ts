import { describe, expect, it } from "vitest";
import { initialState, nextRoundIndex, type GameState } from "@quiz/engine";
import { DEMO_TEXT_GAME, Format, type GameDocument, type Participant, type Transition } from "@quiz/schema";
import {
  COL_GAP, END, END_LAYOUT_KEY, NODE_H, NODE_W, addTransition, defaultCondition, edgeGeometry, edgeLanes, fitView, flowIssues, graphEdges, hitNode, implicitKey, explicitKey,
  movePriority, nextIndex, nodePositions, pickNext, pruneRound, removeTransition, resetNodePos, curveHits, setCondition, setNodePos, setTarget, simulate, zoomAt, type Scenario,
} from "./flow-logic.ts";

// The example of packages/engine/src/flow.test.ts: main → (tie ? barrage : final) ; barrage loops while tied → final → end.
const round = (id: string) => ({ ...DEMO_TEXT_GAME.format.rounds[0]!, id, title: id, questions: ["q_txt_1"], timer: undefined, scoring: [{ type: "base" as const, points: 100 }] }); // oxlint-disable-line typescript/no-non-null-assertion -- fixture has a round
const FLOW: Transition[] = [
  { from: "r_main", to: "r_barrage", when: "tie" },
  { from: "r_main", to: "r_final", when: "always" },
  { from: "r_barrage", to: "r_barrage", when: "tie" },
  { from: "r_barrage", to: "r_final", when: "no-tie" },
  { from: "r_final", to: "end", when: "always" },
];
const fmt = (flow?: Transition[], ids = ["r_main", "r_final", "r_barrage"]): Format => ({ ...DEMO_TEXT_GAME.format, rounds: ids.map(round), ...(flow === undefined ? {} : { flow: structuredClone(flow) }) });

const player = (n: number): Participant => ({ id: `p_${n}`, displayName: `J${n}`, teamId: null, seat: null, status: "active", channel: "play" });
/** A real engine state at the end of round `ri`: two players level (tie) or a single player (no tie). */
function engineState(f: Format, ri: number | null, scenario: Scenario): GameState {
  const game: GameDocument = { ...DEMO_TEXT_GAME, format: f };
  const s = initialState({ schemaVersion: 1, id: "ses_flow", game, seed: 1, createdAt: 0 });
  return { ...s, phase: "round.end", roundIndex: ri, participants: scenario === "tie" ? [player(1), player(2)] : [player(1)] };
}

describe("flow semantics = engine nextRoundIndex", () => {
  it("on the flow.test.ts example, every round × scenario", () => {
    const f = fmt(FLOW);
    for (const ri of [null, 0, 1, 2]) for (const s of ["tie", "no-tie"] as const) expect([ri, s, nextIndex(f, ri, s)]).toEqual([ri, s, nextRoundIndex(engineState(f, ri, s))]);
    expect(nextIndex(f, 0, "tie")).toBe(2); // main tied → barrage
    expect(nextIndex(f, 2, "tie")).toBe(2); // barrage loops
    expect(nextIndex(f, 2, "no-tie")).toBe(1); // → final
    expect(nextIndex(f, 1, "tie")).toBeNull(); // final → end
  });

  it("on generated flows (fall-through, shadowed, unknown order) as well", () => {
    const ids = ["r_a", "r_b", "r_c", "r_d"];
    const targets = [...ids, END];
    const conds = ["always", "tie", "no-tie"] as const;
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 200; k++) {
      const flow: Transition[] = Array.from({ length: rnd(7) }, () => ({ from: ids[rnd(4)] ?? "r_a", to: targets[rnd(5)] ?? END, when: conds[rnd(3)] ?? "always" }));
      const f = fmt(flow, ids);
      for (const ri of [null, 0, 1, 2, 3]) for (const s of ["tie", "no-tie"] as const) expect(nextIndex(f, ri, s)).toBe(nextRoundIndex(engineState(f, ri, s)));
    }
  });

  it("without transitions: the list order", () => {
    const f = fmt();
    expect([0, 1, 2].map((i) => nextIndex(f, i, "tie"))).toEqual([1, 2, null]);
    expect(pickNext(f, 0, "tie")).toEqual({ by: "list", to: "r_final", fallback: false });
  });
});

describe("simulate", () => {
  it("highlights main → barrage → final → end when the main round ends tied and the barrage breaks it", () => {
    const sim = simulate(fmt(FLOW), { r_main: "tie", r_barrage: "no-tie" });
    expect(sim.outcome).toBe("end");
    expect(sim.steps.map((s) => [s.roundId, s.edge, s.to])).toEqual([["r_main", explicitKey(0), "r_barrage"], ["r_barrage", explicitKey(3), "r_final"], ["r_final", explicitKey(4), END]]);
  });
  it("no tie anywhere: main → final → end; barrage always tied: a loop", () => {
    expect(simulate(fmt(FLOW), {}).steps.map((s) => s.roundId)).toEqual(["r_main", "r_final"]);
    const loop = simulate(fmt(FLOW), { r_main: "tie", r_barrage: "tie" });
    expect(loop.outcome).toBe("loop");
    expect(loop.steps.at(-1)).toMatchObject({ roundId: "r_barrage", to: "r_barrage" });
  });
  it("a fall-through uses the list edge", () => {
    const sim = simulate(fmt([{ from: "r_main", to: "r_barrage", when: "tie" }]), {});
    expect(sim.steps[0]).toMatchObject({ edge: implicitKey("r_main"), to: "r_final" });
  });
});

describe("edges", () => {
  it("draws the list order only where it applies, numbers priorities, flags dead transitions", () => {
    const edges = graphEdges(fmt(FLOW));
    expect(edges.map((e) => [e.key, e.from, e.to, e.when, e.priority])).toEqual([
      ["t:0", "r_main", "r_barrage", "tie", 1],
      ["t:1", "r_main", "r_final", "always", 2],
      ["t:4", "r_final", END, "always", 1],
      ["t:2", "r_barrage", "r_barrage", "tie", 1],
      ["t:3", "r_barrage", "r_final", "no-tie", 2],
    ]);
    const partial = graphEdges(fmt([{ from: "r_main", to: "r_main", when: "always" }, { from: "r_main", to: "r_final", when: "tie" }]));
    expect(partial.find((e) => e.key === "t:1")?.shadowed).toBe(true);
    const fall = graphEdges(fmt([{ from: "r_main", to: "r_barrage", when: "tie" }]));
    expect(fall.find((e) => e.key === implicitKey("r_main"))).toMatchObject({ fallback: true, to: "r_final" });
    expect(graphEdges(fmt()).map((e) => [e.from, e.to])).toEqual([["r_main", "r_final"], ["r_final", "r_barrage"], ["r_barrage", END]]);
  });
  it("lanes separate edges of the same pair", () => {
    const lanes = edgeLanes(graphEdges(fmt([{ from: "r_main", to: "r_final", when: "tie" }, { from: "r_main", to: "r_final", when: "no-tie" }, { from: "r_final", to: "r_main", when: "always" }])));
    expect([lanes.get("t:0"), lanes.get("t:1"), lanes.get("t:2")]).toEqual([0, 1, 2]);
  });
  it("geometry: ports on the sides, raised over a node in the way, self-loops above", () => {
    const a = { x: 0, y: 0, w: NODE_W, h: NODE_H };
    const b = { x: 600, y: 0, w: NODE_W, h: NODE_H };
    const mid = { x: 300, y: 0, w: NODE_W, h: NODE_H };
    expect(edgeGeometry(a, b, false, 0).d.startsWith(`M${NODE_W},${NODE_H / 2} `)).toBe(true);
    expect(edgeGeometry(a, b, false, 0).d.endsWith(` 600,${NODE_H / 2}`)).toBe(true);
    expect(edgeGeometry(a, b, false, 0).mid.y).toBe(NODE_H / 2);
    expect(edgeGeometry(a, b, false, 0, [mid]).mid.y).toBeLessThan(0);
    expect(edgeGeometry(a, a, true, 0).mid.y).toBeLessThan(0);
    expect(edgeGeometry(b, a, false, 0).mid.y).toBeGreaterThan(NODE_H);
    // Backward edge with a node under the way: passes below it too.
    const under = { x: 300, y: 120, w: NODE_W, h: NODE_H };
    expect(edgeGeometry(b, a, false, 0, [under]).mid.y).toBeGreaterThan(under.y + under.h);
    const line = [{ x: 0, y: 5 }, { x: 3, y: 5 }, { x: 7, y: 5 }, { x: 10, y: 5 }] as const;
    expect(curveHits(line, [{ x: 4, y: 0, w: 2, h: 10 }])).toBeGreaterThan(0);
    expect(curveHits(line, [{ x: 4, y: 40, w: 2, h: 10 }])).toBe(0);
  });
});

describe("layout and view", () => {
  it("auto-layout left → right in list order, saved positions win, « Fin » last", () => {
    const f = fmt(FLOW);
    const p = nodePositions(f);
    expect([...p.keys()]).toEqual(["r_main", "r_final", "r_barrage", END]);
    const xs = [...p.values()].map((v) => v.x);
    expect(xs).toEqual(xs.toSorted((x, y) => x - y));
    setNodePos(f, "r_final", { x: 2000, y: 0 });
    expect(nodePositions(f).get(END)?.x).toBe(2000 + COL_GAP); // « Fin » follows the right-most round
    setNodePos(f, "r_final", { x: 10.4, y: 400.6 });
    setNodePos(f, END, { x: 900, y: 0 });
    expect(f.flowLayout).toEqual({ r_final: { x: 10, y: 401 }, [END_LAYOUT_KEY]: { x: 900, y: 0 } });
    expect(nodePositions(f).get("r_final")).toEqual({ x: 10, y: 401 });
    expect(nodePositions(f).get(END)).toEqual({ x: 900, y: 0 });
    expect(hitNode(nodePositions(f), { x: 20, y: 420 })).toBe("r_final");
    expect(hitNode(nodePositions(f), { x: -500, y: -500 })).toBeNull();
    resetNodePos(f, "r_final");
    resetNodePos(f, END);
    expect(f.flowLayout).toBeUndefined();
    expect(Format.safeParse(f).success).toBe(true);
  });
  it("fit shows every node, zoom keeps the point under the cursor", () => {
    const v = fitView(nodePositions(fmt(FLOW)), { w: 800, h: 500 });
    expect(v.k).toBeGreaterThan(0.3);
    expect(v.k).toBeLessThanOrEqual(1);
    const z = zoomAt({ x: 10, y: 20, k: 1 }, 2, { x: 110, y: 120 });
    expect(z).toEqual({ k: 2, x: -90, y: -80 });
    expect(zoomAt(z, 100, { x: 0, y: 0 }).k).toBe(2);
  });
});

describe("validation", () => {
  it("the flow.test.ts example is clean", () => {
    expect(flowIssues(fmt(FLOW))).toEqual([]);
    expect(flowIssues(fmt())).toEqual([]);
  });
  it("unreachable round, fall-through explained, dead transition", () => {
    const msgs = flowIssues(fmt([{ from: "r_main", to: "r_barrage", when: "tie" }, { from: "r_barrage", to: "end", when: "always" }, { from: "r_barrage", to: "r_main", when: "tie" }])).map((i) => i.message);
    expect(msgs).toContain("« r_main » : sans égalité, aucune transition ne s'applique ; la partie passe à la manche suivante de la liste, « r_final ». Ajouter une sortie « sinon (pas d'égalité) » ou « toujours » pour le choisir.");
    expect(msgs).toContain("« r_barrage » : la transition n° 2 vers « r_main » ne sera jamais prise (une transition prioritaire couvre déjà ce cas).");
    const skip = flowIssues(fmt([{ from: "r_main", to: "r_barrage", when: "always" }]));
    expect(skip.map((i) => i.message)).toEqual(["« r_final » n'est jamais jouée : aucun chemin ne la relie à la première manche."]);
    expect(skip[0]?.nodes).toEqual(["r_final"]);
  });
  it("last round falling through ends the game, said so", () => {
    const msgs = flowIssues(fmt([{ from: "r_barrage", to: "r_main", when: "tie" }])).map((i) => i.message);
    expect(msgs.some((m) => m.includes("la partie se termine (dernière manche de la liste)"))).toBe(true);
  });
  it("loop without exit and « Fin » unreachable", () => {
    const issues = flowIssues(fmt([{ from: "r_main", to: "r_main", when: "always" }]));
    expect(issues.map((i) => i.message)).toEqual([
      "« r_final » n'est jamais jouée : aucun chemin ne la relie à la première manche.",
      "« r_barrage » n'est jamais jouée : aucun chemin ne la relie à la première manche.",
      "« Fin » n'est atteinte par aucun chemin : la partie ne peut pas se terminer.",
      "Boucle sans sortie : « r_main » → « r_main » ne mène jamais à la fin. Ajouter une sortie « sinon (pas d'égalité) » ou « toujours » hors de la boucle.",
    ]);
    const two = flowIssues(fmt([{ from: "r_main", to: "r_final", when: "always" }, { from: "r_final", to: "r_main", when: "always" }]));
    expect(two.find((i) => i.message.startsWith("Boucle"))?.nodes).toEqual(["r_main", "r_final"]);
    // A self-loop on tie with a no-tie exit is a normal barrage.
    expect(flowIssues(fmt([{ from: "r_barrage", to: "r_barrage", when: "tie" }, { from: "r_barrage", to: "end", when: "no-tie" }]))).toEqual([]);
  });
});

describe("edits", () => {
  it("builds the barrage flow by dragging: conditions default sensibly, priorities kept per round", () => {
    const f = fmt(undefined, ["r_main", "r_final", "r_barrage"]);
    expect(addTransition(f, "r_main", "r_barrage")).toBe(0);
    expect(f.flow?.[0]?.when).toBe("always");
    setCondition(f, 0, "tie");
    expect(defaultCondition(f, "r_main", "r_final")).toBe("no-tie");
    addTransition(f, "r_barrage", "r_barrage"); // self-loop → tie
    expect(addTransition(f, "r_main", "r_final", "always")).toBe(1); // after the other one of r_main
    addTransition(f, "r_barrage", "r_final"); // completes the tie → no-tie
    addTransition(f, "r_final", END);
    expect(f.flow).toEqual(FLOW);
    expect(addTransition(f, "r_main", "r_final", "always")).toBe(1); // duplicate: same index, nothing added
    expect(f.flow).toHaveLength(5);
    expect(movePriority(f, 1, -1)).toBe(0);
    expect(f.flow?.slice(0, 2).map((t) => t.to)).toEqual(["r_final", "r_barrage"]);
    expect(movePriority(f, 0, -1)).toBe(0); // already first
    expect(movePriority(f, 3, 1)).toBe(3); // r_barrage's last: next r_barrage none after
    setTarget(f, 4, "r_nope");
    expect(f.flow?.[4]?.to).toBe(END);
    setTarget(f, 4, "r_main");
    expect(f.flow?.[4]?.to).toBe("r_main");
    removeTransition(f, 4);
    expect(f.flow).toHaveLength(4);
    expect(Format.safeParse(f).success).toBe(true);
  });
  it("priority moves skip the transitions of other rounds", () => {
    const f = fmt([{ from: "r_main", to: "end", when: "tie" }, { from: "r_final", to: "end", when: "always" }, { from: "r_main", to: "r_final", when: "always" }]);
    expect(movePriority(f, 2, -1)).toBe(0);
    expect(f.flow?.map((t) => `${t.from}>${t.to}`)).toEqual(["r_main>r_final", "r_final>end", "r_main>end"]);
  });
  it("removing the last transition or deleting a round cleans the format", () => {
    const f = fmt([{ from: "r_main", to: "r_final", when: "always" }]);
    removeTransition(f, 0);
    expect(f.flow).toBeUndefined();
    const g = fmt(FLOW);
    setNodePos(g, "r_barrage", { x: 1, y: 2 });
    pruneRound(g, "r_barrage");
    expect(g.flow).toEqual([{ from: "r_main", to: "r_final", when: "always" }, { from: "r_final", to: "end", when: "always" }]);
    expect(g.flowLayout).toBeUndefined();
  });
});
