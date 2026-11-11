import type { FlowCondition, Format, Round, Transition } from "@quiz/schema";

/**
 * Format mode, « Enchaînement » view (doc 07, phase 5): the show flow as a node graph. Pure helpers, tested.
 * Semantics mirror the engine's `nextRoundIndex` (packages/engine/src/reduce.ts): the transitions from a round are
 * tried in order, the first whose condition holds wins; no transition, or none matching = next round of the list
 * (then the end). The studio only draws and edits `format.flow` / `format.flowLayout`; the engine decides live.
 */

export type Pos = { readonly x: number; readonly y: number };
export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
/** One scenario of the end of a round: are the two best totals equal? */
export type Scenario = "tie" | "no-tie";
export const SCENARIOS: readonly Scenario[] = ["tie", "no-tie"];

/** The « Fin » node; its position is kept in `flowLayout["end"]` (schema: round id or "end"). */
export const END = "end";
export const END_LAYOUT_KEY = "end";

export const NODE_W = 208;
export const NODE_H = 84;
export const END_W = 104;
export const END_H = 48;
export const COL_GAP = 340;
export const ORIGIN: Pos = { x: 40, y: 140 };

export const CONDITION_LABEL: Record<FlowCondition, string> = { always: "toujours", tie: "si égalité", "no-tie": "sinon (pas d'égalité)" };
export const SCENARIO_LABEL: Record<Scenario, string> = { tie: "égalité", "no-tie": "pas d'égalité" };

type FlowFormat = Pick<Format, "rounds" | "flow" | "flowLayout">;

// ───────────── Layout ─────────────

/** Auto-layout: left → right in list order, « Fin » right of the right-most round. Saved positions win. */
export function nodePositions(f: FlowFormat): Map<string, Pos> {
  const saved = f.flowLayout ?? {};
  const out = new Map<string, Pos>();
  f.rounds.forEach((r, i) => out.set(r.id, saved[r.id] ?? { x: ORIGIN.x + i * COL_GAP, y: ORIGIN.y }));
  const right = Math.max(ORIGIN.x - COL_GAP, ...[...out.values()].map((p) => p.x));
  const endAuto = { x: right + COL_GAP, y: ORIGIN.y + (NODE_H - END_H) / 2 };
  out.set(END, saved[END_LAYOUT_KEY] ?? endAuto);
  return out;
}

export const nodeRect = (id: string, p: Pos): Rect => (id === END ? { x: p.x, y: p.y, w: END_W, h: END_H } : { x: p.x, y: p.y, w: NODE_W, h: NODE_H });

/** Top-most node under a point (graph coordinates), or null. */
export function hitNode(positions: ReadonlyMap<string, Pos>, pt: Pos): string | null {
  let hit: string | null = null;
  for (const [id, p] of positions) {
    const r = nodeRect(id, p);
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) hit = id;
  }
  return hit;
}

export type View = { readonly x: number; readonly y: number; readonly k: number };
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
export const clampZoom = (k: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

/** View that shows every node inside a viewport of `size` (screen px), with a margin, never zoomed above 1. */
export function fitView(positions: ReadonlyMap<string, Pos>, size: { w: number; h: number }, margin = 28): View {
  const rects = [...positions].map(([id, p]) => nodeRect(id, p));
  if (rects.length === 0 || size.w <= 0 || size.h <= 0) return { x: 0, y: 0, k: 1 };
  // Room above for self-loops and labels, below for back edges.
  const minX = Math.min(...rects.map((r) => r.x)) - 20;
  const minY = Math.min(...rects.map((r) => r.y)) - 110;
  const maxX = Math.max(...rects.map((r) => r.x + r.w)) + 20;
  const maxY = Math.max(...rects.map((r) => r.y + r.h)) + 90;
  const k = clampZoom(Math.min(1, (size.w - 2 * margin) / (maxX - minX), (size.h - 2 * margin) / (maxY - minY)));
  return { k, x: (size.w - (maxX - minX) * k) / 2 - minX * k, y: (size.h - (maxY - minY) * k) / 2 - minY * k };
}

/** Zoom by `factor` keeping the screen point `at` fixed. */
export function zoomAt(v: View, factor: number, at: Pos): View {
  const k = clampZoom(v.k * factor);
  const gx = (at.x - v.x) / v.k;
  const gy = (at.y - v.y) / v.k;
  return { k, x: at.x - gx * k, y: at.y - gy * k };
}

export const toGraph = (v: View, screen: Pos): Pos => ({ x: (screen.x - v.x) / v.k, y: (screen.y - v.y) / v.k });

// ───────────── Engine semantics ─────────────

/** What decides the round after `ri`: an explicit transition (index in `flow`), or the list order. */
export type NextPick = { readonly by: "transition"; readonly index: number; readonly to: string } | { readonly by: "list"; readonly to: string; readonly fallback: boolean };

const listNext = (f: FlowFormat, ri: number): string => f.rounds[ri + 1]?.id ?? END;

/** Mirror of the engine's `nextRoundIndex` for round `ri` at the end of a round in `scenario` (`to` = round id or END). */
export function pickNext(f: FlowFormat, ri: number, scenario: Scenario): NextPick {
  const round = f.rounds[ri];
  const flow = f.flow ?? [];
  const from = round === undefined ? [] : flow.flatMap((t, index) => (t.from === round.id ? [{ t, index }] : []));
  if (from.length === 0) return { by: "list", to: listNext(f, ri), fallback: false };
  const tie = scenario === "tie";
  for (const { t, index } of from) {
    if (t.when === "tie" && !tie) continue;
    if (t.when === "no-tie" && tie) continue;
    // The engine ends the game on an unknown target (schema-invalid anyway).
    return { by: "transition", index, to: t.to === END || f.rounds.some((r) => r.id === t.to) ? t.to : END };
  }
  return { by: "list", to: listNext(f, ri), fallback: true };
}

/** Index of the next round (null = end), exactly like `nextRoundIndex` with a state in `scenario`. */
export function nextIndex(f: FlowFormat, ri: number | null, scenario: Scenario): number | null {
  if (ri === null) return f.rounds.length > 0 ? 0 : null;
  const to = pickNext(f, ri, scenario).to;
  if (to === END) return null;
  const i = f.rounds.findIndex((r) => r.id === to);
  return i < 0 ? null : i;
}

export type SimStep = { readonly roundId: string; readonly scenario: Scenario; readonly edge: string; readonly to: string };
export type Simulation = { readonly steps: readonly SimStep[]; readonly outcome: "end" | "loop" };

/**
 * Plays the flow from round 1 with one scenario per round (default: no tie). A round met twice with the same
 * scenario would repeat forever: outcome "loop" (the step that closes the loop is included).
 */
export function simulate(f: FlowFormat, scenarios: Readonly<Record<string, Scenario>>): Simulation {
  const steps: SimStep[] = [];
  const seen = new Set<number>();
  let ri = nextIndex(f, null, "no-tie");
  while (ri !== null) {
    const round = f.rounds[ri];
    if (round === undefined || seen.has(ri)) return { steps, outcome: "loop" };
    seen.add(ri);
    const scenario = scenarios[round.id] ?? "no-tie";
    const pick = pickNext(f, ri, scenario);
    steps.push({ roundId: round.id, scenario, edge: pick.by === "transition" ? explicitKey(pick.index) : implicitKey(round.id), to: pick.to });
    ri = nextIndex(f, ri, scenario);
    if (ri !== null && seen.has(ri)) return { steps, outcome: "loop" };
  }
  return { steps, outcome: "end" };
}

// ───────────── Edges ─────────────

export const explicitKey = (index: number): string => `t:${index}`;
export const implicitKey = (roundId: string): string => `list:${roundId}`;

export type Edge = {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  /** null = list order (dashed). */
  readonly when: FlowCondition | null;
  /** Index in `format.flow` (explicit edges). */
  readonly index: number | null;
  /** 1-based priority among the transitions of `from`, and their count. */
  readonly priority: number;
  readonly siblings: number;
  /** List-order edge drawn because the transitions of `from` may all fail (fallback). */
  readonly fallback: boolean;
  /** Explicit edge that can never fire (an earlier transition covers its case). */
  readonly shadowed: boolean;
};

/** Every edge to draw: explicit transitions, plus the list order where it applies (no transition, or a fall-through). */
export function graphEdges(f: FlowFormat): Edge[] {
  const flow = f.flow ?? [];
  const edges: Edge[] = [];
  f.rounds.forEach((r, ri) => {
    const own = flow.flatMap((t, index) => (t.from === r.id ? [index] : []));
    const picks = SCENARIOS.map((s) => pickNext(f, ri, s));
    own.forEach((index, n) => {
      const t = flow[index];
      if (t === undefined) return;
      const fires = picks.some((p) => p.by === "transition" && p.index === index);
      edges.push({ key: explicitKey(index), from: r.id, to: t.to, when: t.when, index, priority: n + 1, siblings: own.length, fallback: false, shadowed: !fires });
    });
    if (own.length === 0 || picks.some((p) => p.by === "list")) {
      edges.push({ key: implicitKey(r.id), from: r.id, to: listNext(f, ri), when: null, index: null, priority: 0, siblings: own.length, fallback: own.length > 0, shadowed: false });
    }
  });
  return edges;
}

/** Edges sharing a pair of nodes get lanes so they do not overlap: lane 0, 1, 2… per (from, to). */
export function edgeLanes(edges: readonly Edge[]): Map<string, number> {
  const count = new Map<string, number>();
  const lanes = new Map<string, number>();
  for (const e of edges) {
    const pair = e.from === e.to ? `${e.from}>self` : [e.from, e.to].toSorted().join(">");
    const n = count.get(pair) ?? 0;
    lanes.set(e.key, n);
    count.set(pair, n + 1);
  }
  return lanes;
}

export type EdgeGeometry = { readonly d: string; readonly mid: Pos };

const bezierMid = (p0: Pos, p1: Pos, p2: Pos, p3: Pos): Pos => ({ x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 });
const fmt = (n: number): string => String(Math.round(n * 10) / 10);
const curve = (p0: Pos, p1: Pos, p2: Pos, p3: Pos): EdgeGeometry => ({
  d: `M${fmt(p0.x)},${fmt(p0.y)} C${fmt(p1.x)},${fmt(p1.y)} ${fmt(p2.x)},${fmt(p2.y)} ${fmt(p3.x)},${fmt(p3.y)}`,
  mid: bezierMid(p0, p1, p2, p3),
});

export type Bezier = readonly [Pos, Pos, Pos, Pos];

const bezierAt = (c: Bezier, t: number): Pos => {
  const u = 1 - t;
  const [a, b, d, e] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
};
const inside = (p: Pos, r: Rect, pad: number): boolean => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/** How much of the curve runs over nodes: samples inside an obstacle (padded) or inside its own end nodes. */
export function curveHits(c: Bezier, obstacles: readonly Rect[], ends: readonly Rect[] = [], samples = 32): number {
  let n = 0;
  for (let i = 1; i < samples; i++) {
    const p = bezierAt(c, i / samples);
    if (obstacles.some((o) => inside(p, o, 10)) || ends.some((o) => inside(p, o, -2))) n++;
  }
  return n;
}

/**
 * Path of an edge from the output port (right side) of `a` to the input port (left side) of `b`. Forward edges are
 * S-curves, backward edges loop under (or over) the nodes, self-loops go over the node; when the plain route
 * crosses a node, the edge passes above or below the nodes in its way (the closest that is clear).
 */
export function edgeGeometry(a: Rect, b: Rect, self: boolean, lane: number, obstacles: readonly Rect[] = [], labelW = 0): EdgeGeometry {
  const g = edgeCurve(a, b, self, lane, obstacles);
  return { d: g.d, mid: labelSpot(g.c, labelW, [a, b, ...obstacles]) };
}

const overlaps = (r: Rect, o: Rect, pad: number): boolean => r.x < o.x + o.w + pad && r.x + r.w > o.x - pad && r.y < o.y + o.h + pad && r.y + r.h > o.y - pad;

/** Where the label chip (width `w`, height 18) goes: the middle of the curve, or the nearest point along it clear of every node. */
export function labelSpot(c: Bezier, w: number, nodes: readonly Rect[]): Pos {
  const mid = bezierAt(c, 0.5);
  if (w <= 0) return mid;
  for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74]) {
    const p = bezierAt(c, t);
    if (!nodes.some((n) => overlaps({ x: p.x - w / 2, y: p.y - 9, w, h: 18 }, n, 4))) return p;
  }
  return mid;
}

function edgeCurve(a: Rect, b: Rect, self: boolean, lane: number, obstacles: readonly Rect[]): EdgeGeometry & { c: Bezier } {
  const s = { x: a.x + a.w, y: a.y + a.h / 2 };
  const e = { x: b.x, y: b.y + b.h / 2 };
  if (self) {
    const top = a.y - 64 - lane * 30;
    const loop: Bezier = [s, { x: s.x + 80 + lane * 20, y: top - 26 }, { x: e.x - 80 - lane * 20, y: top - 26 }, e];
    return { ...curve(...loop), c: loop };
  }
  const forward = e.x >= s.x + 24;
  const [x0, x1] = [Math.min(s.x, e.x), Math.max(s.x, e.x)];
  const span = [a, b, ...obstacles.filter((o) => o.x + o.w > x0 - 20 && o.x < x1 + 20)];
  const gap = forward ? 30 : 46;
  const top = Math.min(...span.map((o) => o.y)) - gap - lane * 26;
  const bottom = Math.max(...span.map((o) => o.y + o.h)) + gap + lane * 26;
  const c = forward ? Math.max(40, (e.x - s.x) / 2) : 90;
  const c1x = s.x + c;
  const c2x = e.x - c;
  // Both control points at the same height: the curve's middle sits exactly at `y`.
  const via = (y: number): Bezier => {
    const cy = (8 * y - s.y - e.y) / 6;
    return [s, { x: c1x, y: cy }, { x: c2x, y: cy }, e];
  };
  const straight: Bezier = [s, { x: c1x, y: s.y - lane * 35 }, { x: c2x, y: e.y - lane * 35 }, e];
  const candidates: { c: Bezier; cost: number }[] = forward
    ? [{ c: straight, cost: lane * 26 }, { c: via(top), cost: Math.abs(top - (s.y + e.y) / 2) }, { c: via(bottom), cost: Math.abs(bottom - (s.y + e.y) / 2) }]
    : [{ c: via(bottom), cost: 0 }, { c: via(top), cost: 1 }];
  const best = candidates.map((k) => ({ ...k, score: curveHits(k.c, obstacles, [a, b]) * 1000 + k.cost })).toSorted((m, n) => m.score - n.score)[0] ?? { c: straight };
  return { ...curve(...best.c), c: best.c };
}

// ───────────── Validation ─────────────

export type FlowIssue = { readonly message: string; readonly nodes: readonly string[]; readonly edges: readonly string[] };

const title = (f: FlowFormat, id: string): string => (id === END ? "Fin" : (f.rounds.find((r) => r.id === id)?.title ?? id));
const q = (s: string): string => `« ${s} »`;

/** Rounds reachable after round `ri` (any scenario). */
function successors(f: FlowFormat, ri: number): Set<string> {
  return new Set(SCENARIOS.map((s) => pickNext(f, ri, s).to));
}

function reachableFrom(f: FlowFormat, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const todo = [start];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    const ri = f.rounds.findIndex((r) => r.id === id);
    if (ri < 0) continue;
    for (const n of successors(f, ri)) {
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
    }
  }
  return seen;
}

/** French warnings of the flow: unreachable rounds, fall-throughs, dead transitions, end unreachable, loops without exit. */
export function flowIssues(f: FlowFormat): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const first = f.rounds[0];
  if (first === undefined) return issues;
  const fromStart = reachableFrom(f, first.id);
  for (const r of f.rounds) {
    if (!fromStart.has(r.id)) issues.push({ message: `${q(r.title)} n'est jamais jouée : aucun chemin ne la relie à la première manche.`, nodes: [r.id], edges: [] });
  }
  const edges = graphEdges(f);
  f.rounds.forEach((r, ri) => {
    const own = edges.filter((e) => e.from === r.id && e.index !== null);
    if (own.length === 0) return;
    for (const s of SCENARIOS) {
      const p = pickNext(f, ri, s);
      if (p.by !== "list") continue;
      const then = p.to === END ? "la partie se termine (dernière manche de la liste)" : `la partie passe à la manche suivante de la liste, ${q(title(f, p.to))}`;
      const when = s === "tie" ? "en cas d'égalité" : "sans égalité";
      issues.push({ message: `${q(r.title)} : ${when}, aucune transition ne s'applique ; ${then}. Ajouter une sortie « ${s === "tie" ? "si égalité" : "sinon (pas d'égalité)"} » ou « toujours » pour le choisir.`, nodes: [r.id], edges: [implicitKey(r.id)] });
    }
    for (const e of own) {
      if (e.shadowed) issues.push({ message: `${q(r.title)} : la transition n° ${e.priority} vers ${q(title(f, e.to))} ne sera jamais prise (une transition prioritaire couvre déjà ce cas).`, nodes: [r.id], edges: [e.key] });
    }
  });
  if (!fromStart.has(END)) issues.push({ message: "« Fin » n'est atteinte par aucun chemin : la partie ne peut pas se terminer.", nodes: [END], edges: [] });
  // Loops without exit: rounds on a cycle from which the end can never be reached.
  const reach = new Map(f.rounds.map((r) => [r.id, reachableFrom(f, r.id)]));
  const reported = new Set<string>();
  for (const r of f.rounds) {
    const mine = reach.get(r.id);
    if (mine === undefined || mine.has(END) || reported.has(r.id)) continue;
    const ri = f.rounds.findIndex((x) => x.id === r.id);
    const onCycle = [...successors(f, ri)].some((n) => reach.get(n)?.has(r.id) === true);
    if (!onCycle) continue;
    const cycle = f.rounds.filter((x) => mine.has(x.id) && reach.get(x.id)?.has(r.id) === true).map((x) => x.id);
    cycle.forEach((id) => reported.add(id));
    const path = [...cycle, cycle[0] ?? r.id].map((id) => q(title(f, id))).join(" → ");
    const loopEdges = edges.filter((e) => cycle.includes(e.from) && cycle.includes(e.to)).map((e) => e.key);
    issues.push({ message: `Boucle sans sortie : ${path} ne mène jamais à la fin. Ajouter une sortie « sinon (pas d'égalité) » ou « toujours » hors de la boucle.`, nodes: cycle, edges: loopEdges });
  }
  return issues;
}

// ───────────── Edits (mutating, applied inside a store `produce`) ─────────────

/** Sensible condition for a new transition from `from`: complete what is missing, a self-loop is a tie-break. */
export function defaultCondition(f: FlowFormat, from: string, to: string): FlowCondition {
  const own = (f.flow ?? []).filter((t) => t.from === from).map((t) => t.when);
  const has = (c: FlowCondition) => own.includes(c);
  if (from === to && !has("tie")) return "tie";
  if (own.length === 0 || has("always") || (has("tie") && has("no-tie"))) return "always";
  return has("tie") ? "no-tie" : "tie";
}

/** Adds a transition after the last one of `from` (lowest priority). Returns its index, or the existing one for a duplicate. */
export function addTransition(f: FlowFormat, from: string, to: string, when: FlowCondition = defaultCondition(f, from, to)): number {
  const flow = f.flow ?? [];
  if (f.flow === undefined) f.flow = flow;
  const dup = flow.findIndex((t) => t.from === from && t.to === to && t.when === when);
  if (dup >= 0) return dup;
  let at = flow.length;
  flow.forEach((t, i) => { if (t.from === from) at = i + 1; });
  flow.splice(at, 0, { from, to, when } satisfies Transition);
  return at;
}

export function removeTransition(f: FlowFormat, index: number): void {
  if (f.flow === undefined || f.flow[index] === undefined) return;
  f.flow.splice(index, 1);
  if (f.flow.length === 0) delete f.flow;
}

export function setCondition(f: FlowFormat, index: number, when: FlowCondition): void {
  const t = f.flow?.[index];
  if (t !== undefined) t.when = when;
}

export function setTarget(f: FlowFormat, index: number, to: string): void {
  const t = f.flow?.[index];
  if (t !== undefined && (to === END || f.rounds.some((r) => r.id === to))) t.to = to;
}

/** Swaps a transition with the previous (-1) / next (+1) one of the same round. Returns its new index. */
export function movePriority(f: FlowFormat, index: number, dir: -1 | 1): number {
  const flow = f.flow;
  const t = flow?.[index];
  if (flow === undefined || t === undefined) return index;
  let j = index + dir;
  while (j >= 0 && j < flow.length && flow[j]?.from !== t.from) j += dir;
  const other = flow[j];
  if (other === undefined) return index;
  flow[j] = t;
  flow[index] = other;
  return j;
}

export function setNodePos(f: FlowFormat, id: string, p: Pos): void {
  const layout = f.flowLayout ?? {};
  if (f.flowLayout === undefined) f.flowLayout = layout;
  layout[id === END ? END_LAYOUT_KEY : id] = { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Back to the automatic position. */
export function resetNodePos(f: FlowFormat, id: string): void {
  if (f.flowLayout === undefined) return;
  delete f.flowLayout[id === END ? END_LAYOUT_KEY : id];
  if (Object.keys(f.flowLayout).length === 0) delete f.flowLayout;
}

/** A deleted round takes its transitions (both ways) and its position with it. */
export function pruneRound(f: FlowFormat, roundId: string): void {
  if (f.flow !== undefined) {
    f.flow = f.flow.filter((t) => t.from !== roundId && t.to !== roundId);
    if (f.flow.length === 0) delete f.flow;
  }
  resetNodePos(f, roundId);
}

/** Node summary: « 3 questions ». */
export const questionCount = (r: Pick<Round, "questions">): string => `${r.questions.length} question${r.questions.length > 1 ? "s" : ""}`;
