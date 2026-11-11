import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { FlowCondition, GameDocument, Round } from "@quiz/schema";
import { Button, isDialogOpen } from "@quiz/ui";
import {
  CONDITION_LABEL, END, END_H, END_LAYOUT_KEY, END_W, NODE_H, NODE_W, SCENARIOS, SCENARIO_LABEL, addTransition, edgeGeometry, edgeLanes, fitView, flowIssues, graphEdges, hitNode,
  movePriority, nodePositions, nodeRect, questionCount, removeTransition, resetNodePos, setCondition, setNodePos, setTarget, simulate, toGraph, zoomAt,
  type Edge, type Pos, type Scenario, type View,
} from "./flow-logic.ts";
import { mechanicLabel } from "./format-logic.ts";
import { inField, type Update } from "./util.ts";

type Selection = { readonly kind: "edge"; readonly index: number } | { readonly kind: "node"; readonly id: string } | null;
type Drag =
  | { readonly kind: "node"; readonly id: string; readonly start: Pos; readonly origin: Pos; readonly moved: boolean }
  | { readonly kind: "pan"; readonly start: Pos; readonly view: View; readonly moved: boolean }
  | { readonly kind: "connect"; readonly from: string; readonly at: Pos }
  | null;

const CONDITIONS: readonly FlowCondition[] = ["always", "tie", "no-tie"];
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Text of the condition chip of an edge ("" = no chip). */
const edgeLabel = (e: Edge): string => (e.when === null ? (e.fallback ? "sinon : ordre de la liste" : "") : `${e.siblings > 1 ? `${e.priority} · ` : ""}${CONDITION_LABEL[e.when]}`);
/** Approximate width of a label chip (condensed caps, 10px). */
const chipWidth = (s: string): number => Math.round(s.length * 5.9 + 14);

/** Format mode, « Enchaînement » view (doc 07, phase 5): the show flow as a node graph (SVG). */
export function FlowEditor(p: { doc: GameDocument; update: Update }): JSX.Element {
  const format = () => p.doc.format;
  const [view, setView] = createSignal<View>({ x: 0, y: 0, k: 1 });
  const [sel, setSel] = createSignal<Selection>(null);
  const [drag, setDrag] = createSignal<Drag>(null);
  const [dragPos, setDragPos] = createSignal<{ id: string; pos: Pos } | null>(null);
  const [menu, setMenu] = createSignal<string | null>(null);
  const [simOn, setSimOn] = createSignal(false);
  const [scenarios, setScenarios] = createSignal<Record<string, Scenario>>({});
  let viewport: HTMLDivElement | undefined;
  let svg: SVGSVGElement | undefined;

  const positions = createMemo(() => {
    const m = nodePositions(format());
    const d = dragPos();
    if (d !== null) m.set(d.id, d.pos);
    return m;
  });
  const rectOf = (id: string) => nodeRect(id, positions().get(id) ?? { x: 0, y: 0 });
  const edges = createMemo(() => graphEdges(format()));
  const lanes = createMemo(() => edgeLanes(edges()));
  const issues = createMemo(() => flowIssues(format()));
  const warnNodes = createMemo(() => new Set(issues().flatMap((i) => i.nodes)));
  const warnEdges = createMemo(() => new Set(issues().flatMap((i) => i.edges)));
  const sim = createMemo(() => (simOn() ? simulate(format(), scenarios()) : null));
  const simEdges = createMemo(() => new Set(sim()?.steps.map((s) => s.edge) ?? []));
  const simStep = createMemo(() => {
    const m = new Map<string, number[]>();
    sim()?.steps.forEach((s, i) => m.set(s.roundId, [...(m.get(s.roundId) ?? []), i + 1]));
    const last = sim()?.steps.at(-1);
    if (sim()?.outcome === "end" && last !== undefined) m.set(END, [(sim()?.steps.length ?? 0) + 1]);
    return m;
  });
  const endPos = () => positions().get(END) ?? { x: 0, y: 0 };
  const endSteps = () => simStep().get(END) ?? [];
  const roundOf = (id: string): Round | undefined => format().rounds.find((r) => r.id === id);
  const titleOf = (id: string): string => (id === END ? "Fin" : (roundOf(id)?.title ?? id));
  const selEdge = (): Edge | undefined => {
    const s = sel();
    return s?.kind === "edge" ? edges().find((e) => e.index === s.index) : undefined;
  };
  const selNode = (): string | null => {
    const s = sel();
    return s?.kind === "node" ? s.id : null;
  };
  const hasSavedPos = (id: string): boolean => format().flowLayout?.[id === END ? END_LAYOUT_KEY : id] !== undefined;
  const siblingsOf = (from: string): Edge[] => edges().filter((e) => e.from === from && e.index !== null);

  // ── Geometry ──
  const screenPt = (e: PointerEvent | WheelEvent | MouseEvent): Pos => {
    const r = svg?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const fit = () => {
    if (viewport === undefined) return;
    setView(fitView(positions(), { w: viewport.clientWidth, h: viewport.clientHeight }));
  };
  const zoomBy = (factor: number) => {
    const w = viewport?.clientWidth ?? 0;
    const h = viewport?.clientHeight ?? 0;
    setView(zoomAt(view(), factor, { x: w / 2, y: h / 2 }));
  };
  const geometry = (e: Edge) => {
    const a = rectOf(e.from);
    const b = rectOf(e.to);
    const obstacles = [...positions()].filter(([id]) => id !== e.from && id !== e.to).map(([id, pos]) => nodeRect(id, pos));
    const label = edgeLabel(e);
    return edgeGeometry(a, b, e.from === e.to, lanes().get(e.key) ?? 0, obstacles, label === "" ? 0 : chipWidth(label));
  };

  const geoms = createMemo(() => new Map(edges().map((e) => [e.key, geometry(e)])));
  const edgeState = (e: Edge): "sel" | "path" | "warn" | "list" | "base" => {
    if (e.index !== null && selEdge()?.key === e.key) return "sel";
    if (simEdges().has(e.key)) return "path";
    if (e.shadowed || warnEdges().has(e.key)) return "warn";
    return e.when === null ? "list" : "base";
  };
  const pickEdge = (e: Edge, ev: PointerEvent) => {
    if (e.index === null || ev.button !== 0) return;
    ev.stopPropagation();
    setMenu(null);
    setSel({ kind: "edge", index: e.index });
  };

  // ── Edits ──
  const edit = (f: (fmt: GameDocument["format"]) => void, key?: string) => p.update((d) => f(d.format), key);
  const connect = (from: string, to: string, when?: FlowCondition) => {
    let index = -1;
    edit((f) => { index = addTransition(f, from, to, when); });
    if (index >= 0) setSel({ kind: "edge", index });
    setMenu(null);
  };
  const deleteSelected = () => {
    const s = sel();
    if (s === null) return;
    if (s.kind === "edge") {
      edit((f) => removeTransition(f, s.index));
      setSel(null);
    } else if (hasSavedPos(s.id)) {
      edit((f) => resetNodePos(f, s.id));
    }
  };
  const move = (index: number, dir: -1 | 1) => {
    let next = index;
    edit((f) => { next = movePriority(f, index, dir); });
    setSel({ kind: "edge", index: next });
  };

  // ── Pointer: drag nodes, draw transitions from the output port, pan on empty space ──
  const capture = (e: PointerEvent) => svg?.setPointerCapture(e.pointerId);
  const onNodeDown = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    capture(e);
    setDrag({ kind: "node", id, start: screenPt(e), origin: positions().get(id) ?? { x: 0, y: 0 }, moved: false });
  };
  const onPortDown = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    capture(e);
    setDrag({ kind: "connect", from: id, at: toGraph(view(), screenPt(e)) });
  };
  const onBackgroundDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setMenu(null);
    capture(e);
    setDrag({ kind: "pan", start: screenPt(e), view: view(), moved: false });
  };
  const onMove = (e: PointerEvent) => {
    const d = drag();
    if (d === null) return;
    const pt = screenPt(e);
    if (d.kind === "connect") {
      setDrag({ ...d, at: toGraph(view(), pt) });
      return;
    }
    const dx = pt.x - d.start.x;
    const dy = pt.y - d.start.y;
    const moved = d.moved || Math.abs(dx) + Math.abs(dy) > 3;
    if (d.kind === "pan") {
      setDrag({ ...d, moved });
      if (moved) setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
      return;
    }
    setDrag({ ...d, moved });
    if (moved) setDragPos({ id: d.id, pos: { x: d.origin.x + dx / view().k, y: d.origin.y + dy / view().k } });
  };
  const onUp = (e: PointerEvent) => {
    const d = drag();
    setDrag(null);
    if (d === null) return;
    if (d.kind === "connect") {
      const target = hitNode(positions(), toGraph(view(), screenPt(e)));
      if (target !== null) connect(d.from, target);
      return;
    }
    if (d.kind === "pan") {
      if (!d.moved) setSel(null);
      return;
    }
    const dp = dragPos();
    setDragPos(null);
    if (d.moved && dp !== null) edit((f) => setNodePos(f, d.id, dp.pos));
    setSel({ kind: "node", id: d.id });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setView(zoomAt(view(), Math.exp(-e.deltaY * 0.0015), screenPt(e)));
      return;
    }
    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
    setView({ ...view(), x: view().x - dx, y: view().y - dy });
  };

  // ── Keyboard: Suppr deletes the selected transition / resets the node position, Échap deselects ──
  const onKey = (e: KeyboardEvent) => {
    if (isDialogOpen()) return; // our dialog owns the keyboard (Entrée / Échap)
    if (inField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (drag()?.kind === "connect") setDrag(null);
      else if (menu() !== null) setMenu(null);
      else setSel(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (sel() === null) return;
      e.preventDefault();
      deleteSelected();
    }
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(fit);
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const targets = (): { id: string; label: string }[] => [...format().rounds.map((r, i) => ({ id: r.id, label: `${String(i + 1).padStart(2, "0")} · ${r.title}` })), { id: END, label: "Fin" }];
  const connecting = createMemo(() => {
    const d = drag();
    return d?.kind === "connect" ? d : null;
  });
  const dropTarget = createMemo(() => {
    const d = drag();
    return d?.kind === "connect" ? hitNode(positions(), d.at) : null;
  });

  return (
    <div class="s-flow">
      <div class="s-flow-col">
        <div class="s-toolbar s-flow-toolbar">
          <div class="s-seg" role="group" aria-label="Zoom">
            <button type="button" title="Dézoomer" onClick={() => zoomBy(1 / 1.2)}>−</button>
            <button type="button" title="Zoomer" onClick={() => zoomBy(1.2)}>+</button>
            <button type="button" title="Tout afficher" onClick={fit}>Ajuster</button>
          </div>
          <span class="q-mono muted s-flow-zoom">{Math.round(view().k * 100)} %</span>
          <span class="s-sep" />
          <Button kind="ghost" disabled={format().flowLayout === undefined} title="Replacer toutes les manches de gauche à droite, dans l'ordre de la liste" onClick={() => { edit((f) => { delete f.flowLayout; }); requestAnimationFrame(fit); }}>Disposer automatiquement</Button>
          <span class="s-spacer" />
          <span class="s-flow-legend muted"><i class="s-flow-key-list" /> ordre de la liste <i class="s-flow-key-flow" /> transition</span>
        </div>
        <div class="s-flow-viewport" ref={viewport}>
          <svg
            ref={svg}
            class="s-flow-svg"
            data-drag={drag()?.kind ?? "none"}
            role="application"
            aria-label="Graphe de l'enchaînement des manches"
            onPointerDown={onBackgroundDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => { setDrag(null); setDragPos(null); }}
            onWheel={onWheel}
          >
            <defs>
              <For each={["base", "list", "sel", "path", "warn"]}>
                {(k) => (
                  <marker id={`s-flow-arrow-${k}`} class={`s-flow-arrow s-flow-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M0,0 L10,5 L0,10 z" />
                  </marker>
                )}
              </For>
              <pattern id="s-flow-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle class="s-flow-dot" cx="1" cy="1" r="1" />
              </pattern>
            </defs>
            <rect class="s-flow-bg" width="100%" height="100%" />
            <g transform={`translate(${view().x} ${view().y}) scale(${view().k})`}>
              <For each={edges()}>
                {(e) => (
                  <g class="s-flow-edge" data-kind={e.when === null ? "list" : "flow"} data-state={edgeState(e)} data-edge={e.key} data-from={titleOf(e.from)} data-to={titleOf(e.to)}>
                    <Show when={e.index !== null}><path class="s-flow-hit" d={geoms().get(e.key)?.d} onPointerDown={(ev) => pickEdge(e, ev)} /></Show>
                    <path class="s-flow-line" d={geoms().get(e.key)?.d} marker-end={`url(#s-flow-arrow-${edgeState(e)})`} />
                  </g>
                )}
              </For>
              <Show when={connecting()}>
                {(d) => {
                  const s = () => { const r = rectOf(d().from); return { x: r.x + r.w, y: r.y + r.h / 2 }; };
                  return <line class="s-flow-temp" x1={s().x} y1={s().y} x2={d().at.x} y2={d().at.y} />;
                }}
              </Show>
              <For each={format().rounds}>
                {(r, i) => {
                  const pos = () => positions().get(r.id) ?? { x: 0, y: 0 };
                  const steps = () => simStep().get(r.id) ?? [];
                  return (
                    <g
                      class="s-flow-node"
                      transform={`translate(${pos().x} ${pos().y})`}
                      data-title={r.title}
                      data-sel={String(selNode() === r.id)}
                      data-warn={String(warnNodes().has(r.id))}
                      data-path={String(steps().length > 0)}
                      data-drop={String(dropTarget() === r.id)}
                      onPointerDown={(e) => onNodeDown(r.id, e)}
                    >
                      <title>{r.title}</title>
                      <rect class="s-flow-box" width={NODE_W} height={NODE_H} rx="3" />
                      <rect class="s-flow-head" x="1" y="1" width={NODE_W - 2} height="24" />
                      <line class="s-flow-rule" x1="0" y1="25" x2={NODE_W} y2="25" />
                      <rect class="s-flow-warnbar" x="0" y="0" width="3" height={NODE_H} />
                      <text class="s-flow-num" x="10" y="17">{String(i() + 1).padStart(2, "0")}</text>
                      <text class="s-flow-title" x="34" y="17">{clip(r.title, 22)}</text>
                      <Show when={i() === 0}><text class="s-flow-start" x="0" y="-7">DÉPART</text></Show>
                      <text class="s-flow-mech" x="10" y="46">{mechanicLabel(r.mechanic)}</text>
                      <text class="s-flow-count" x="10" y="68">{questionCount(r)}</text>
                      <g class="s-flow-add" transform={`translate(${NODE_W - 62} ${NODE_H - 24})`} role="button" aria-label={`Ajouter une suite à « ${r.title} »`} onPointerDown={(e) => { e.stopPropagation(); setSel({ kind: "node", id: r.id }); setMenu(menu() === r.id ? null : r.id); }}>
                        <rect width="54" height="17" rx="2" />
                        <text x="27" y="12" text-anchor="middle">+ SUITE</text>
                      </g>
                      <Show when={steps().length > 0}>
                        <g class="s-flow-step" transform={`translate(${NODE_W - 8} -9)`}>
                          <rect x={-(steps().join(", ").length * 7 + 10)} width={steps().join(", ").length * 7 + 10} height="17" rx="2" />
                          <text x="-5" y="12.5" text-anchor="end">{steps().join(", ")}</text>
                        </g>
                      </Show>
                      <rect class="s-flow-in" x="-5" y={NODE_H / 2 - 5} width="10" height="10" />
                      <circle class="s-flow-out" cx={NODE_W} cy={NODE_H / 2} r="7" role="button" aria-label={`Sortie de « ${r.title} »`} onPointerDown={(e) => onPortDown(r.id, e)} />
                    </g>
                  );
                }}
              </For>
              <g
                class="s-flow-node s-flow-end"
                transform={`translate(${endPos().x} ${endPos().y})`}
                data-title="Fin"
                data-sel={String(selNode() === END)}
                data-warn={String(warnNodes().has(END))}
                data-path={String(endSteps().length > 0)}
                data-drop={String(dropTarget() === END)}
                onPointerDown={(e) => onNodeDown(END, e)}
              >
                <rect class="s-flow-box" width={END_W} height={END_H} rx="3" />
                <rect class="s-flow-warnbar" x="0" y="0" width="3" height={END_H} />
                <text class="s-flow-endlabel" x={END_W / 2} y={END_H / 2 + 5} text-anchor="middle">FIN</text>
                <rect class="s-flow-in" x="-5" y={END_H / 2 - 5} width="10" height="10" />
              </g>
              {/* Condition chips above the nodes, so a label is never hidden. */}
              <For each={edges().filter((e) => edgeLabel(e) !== "")}>
                {(e) => {
                  const mid = () => geoms().get(e.key)?.mid ?? { x: 0, y: 0 };
                  return (
                    <g class="s-flow-label" data-kind={e.when === null ? "list" : "flow"} data-state={edgeState(e)} data-from={titleOf(e.from)} data-to={titleOf(e.to)}>
                      <g class="s-flow-chip" transform={`translate(${mid().x} ${mid().y})`} onPointerDown={(ev) => pickEdge(e, ev)}>
                        <rect x={-chipWidth(edgeLabel(e)) / 2} y="-9" width={chipWidth(edgeLabel(e))} height="18" rx="2" />
                        <text y="3.5" text-anchor="middle">{edgeLabel(e)}</text>
                      </g>
                    </g>
                  );
                }}
              </For>
            </g>
          </svg>
          <Show when={menu()}>
            {(id) => {
              const at = () => {
                const r = rectOf(id());
                const v = view();
                return { left: `${v.x + (r.x + r.w - 62) * v.k}px`, top: `${v.y + (r.y + r.h) * v.k + 4}px` };
              };
              return (
                <div class="s-flow-menu" role="menu" aria-label={`Suite de « ${titleOf(id())} »`} style={at()}>
                  <span class="s-label">Après « {clip(titleOf(id()), 28)} »</span>
                  <For each={targets()}>
                    {(t) => <button type="button" role="menuitem" onClick={() => connect(id(), t.id)}>{t.id === id() ? `${t.label} (boucle)` : t.label}</button>}
                  </For>
                </div>
              );
            }}
          </Show>
        </div>
      </div>

      <aside class="s-flow-side">
        <section class="s-flow-sec">
          <Show when={selEdge()} fallback={<NodeOrHelp />}>
            {(e) => (
              <div class="s-stack" data-testid="flow-edge">
                <span class="s-label">Transition</span>
                <p class="s-flow-edge-title">« {titleOf(e().from)} » → « {titleOf(e().to)} »</p>
                <label class="s-field"><span class="s-label">Vers</span>
                  <select aria-label="Destination de la transition" value={e().to} onChange={(ev) => { const v = ev.currentTarget.value; const ix = e().index; if (ix !== null) edit((f) => setTarget(f, ix, v)); }}>
                    <For each={targets()}>{(t) => <option value={t.id}>{t.id === e().from ? `${t.label} (boucle)` : t.label}</option>}</For>
                  </select>
                </label>
                <div class="s-field"><span class="s-label">Condition</span>
                  <div class="s-seg s-flow-cond" role="group" aria-label="Condition">
                    <For each={CONDITIONS}>{(c) => <button type="button" data-on={String(e().when === c)} onClick={() => { const ix = e().index; if (ix !== null) edit((f) => setCondition(f, ix, c)); }}>{CONDITION_LABEL[c]}</button>}</For>
                  </div>
                </div>
                <Show when={e().shadowed}><p class="s-warn-text">Jamais prise : une transition prioritaire couvre déjà ce cas.</p></Show>
                <div class="s-field"><span class="s-label">Priorité parmi les sorties de « {clip(titleOf(e().from), 24)} »</span>
                  <ol class="s-flow-prio">
                    <For each={siblingsOf(e().from)}>
                      {(s, n) => (
                        <li data-on={String(s.key === e().key)} data-dead={String(s.shadowed)}>
                          <button type="button" class="s-flow-prio-pick" onClick={() => { if (s.index !== null) setSel({ kind: "edge", index: s.index }); }}>
                            <span class="q-mono">{n() + 1}</span>
                            <span class="s-flow-prio-to">→ {titleOf(s.to)}</span>
                            <span class="s-kind">{s.when === null ? "" : CONDITION_LABEL[s.when]}</span>
                          </button>
                          <Button kind="ghost" title="Plus prioritaire" disabled={n() === 0} onClick={() => { if (s.index !== null) move(s.index, -1); }}>↑</Button>
                          <Button kind="ghost" title="Moins prioritaire" disabled={n() === siblingsOf(e().from).length - 1} onClick={() => { if (s.index !== null) move(s.index, 1); }}>↓</Button>
                        </li>
                      )}
                    </For>
                  </ol>
                  <p class="muted s-hint">Essayées dans l'ordre : la première dont la condition est vraie l'emporte. Si aucune ne s'applique, la manche suivante de la liste est jouée.</p>
                </div>
                <div class="s-row">
                  <Button kind="danger" onClick={deleteSelected}>Supprimer la transition</Button>
                  <span class="muted s-hint"><kbd>Suppr</kbd></span>
                </div>
              </div>
            )}
          </Show>
        </section>

        <section class="s-flow-sec">
          <span class="s-label">Vérifications <span class="q-mono">· {issues().length}</span></span>
          <Show when={issues().length > 0} fallback={<p class="s-ok s-hint">Enchaînement valide : chaque manche est jouable et la fin est atteinte.</p>}>
            <ul class="s-flow-issues">
              <For each={issues()}>{(i) => <li>{i.message}</li>}</For>
            </ul>
          </Show>
        </section>

        <section class="s-flow-sec">
          <div class="s-row s-flow-simhead">
            <span class="s-label">Simuler</span>
            <span class="s-spacer" />
            <button type="button" class="q-switch" role="switch" aria-checked={simOn()} onClick={() => setSimOn(!simOn())}>{simOn() ? "activé" : "désactivé"}</button>
          </div>
          <Show when={simOn()} fallback={<p class="muted s-hint">Choisir, manche par manche, s'il y a égalité en tête à la fin, et voir le chemin suivi par la partie.</p>}>
            <ul class="s-flow-scen">
              <For each={format().rounds}>
                {(r, i) => (
                  <li>
                    <span class="q-mono muted">{String(i() + 1).padStart(2, "0")}</span>
                    <span class="s-flow-scen-title" title={r.title}>{r.title}</span>
                    <div class="s-seg" role="group" aria-label={`Fin de « ${r.title} »`}>
                      <For each={SCENARIOS}>{(s) => <button type="button" data-on={String((scenarios()[r.id] ?? "no-tie") === s)} onClick={() => setScenarios({ ...scenarios(), [r.id]: s })}>{SCENARIO_LABEL[s]}</button>}</For>
                    </div>
                  </li>
                )}
              </For>
            </ul>
            <Show when={sim()}>
              {(s) => (
                <div class="s-flow-path" data-outcome={s().outcome}>
                  <span class="s-label">Chemin</span>
                  <ol>
                    <For each={s().steps}>{(st) => <li><span>{titleOf(st.roundId)}</span> <span class="muted">({SCENARIO_LABEL[st.scenario]})</span></li>}</For>
                    <Show when={s().outcome === "end"}><li><span>Fin</span></li></Show>
                  </ol>
                  <Show when={s().outcome === "loop"}><p class="s-warn-text">Avec ces choix, « {titleOf(s().steps.at(-1)?.to ?? END)} » se rejoue sans fin.</p></Show>
                </div>
              )}
            </Show>
          </Show>
        </section>
      </aside>
    </div>
  );

  function NodeOrHelp(): JSX.Element {
    return (
      <Show when={selNode()} fallback={<FlowHelp />}>
        {(id) => (
          <div class="s-stack" data-testid="flow-node">
            <span class="s-label">{id() === END ? "Fin de la partie" : "Manche"}</span>
            <p class="s-flow-edge-title">{titleOf(id())}</p>
            <Show when={roundOf(id())}>
              {(r) => (
                <>
                  <p class="muted s-hint">{mechanicLabel(r().mechanic)} · {questionCount(r())}. Contenu et réglages : vue Liste.</p>
                  <span class="s-label">Sorties</span>
                  <ol class="s-flow-prio">
                    <For each={edges().filter((e) => e.from === id())}>
                      {(e) => (
                        <li data-dead={String(e.shadowed)}>
                          <button type="button" class="s-flow-prio-pick" disabled={e.index === null} onClick={() => { if (e.index !== null) setSel({ kind: "edge", index: e.index }); }}>
                            <span class="q-mono">{e.index === null ? "—" : e.priority}</span>
                            <span class="s-flow-prio-to">→ {titleOf(e.to)}</span>
                            <span class="s-kind">{e.when === null ? "ordre de la liste" : CONDITION_LABEL[e.when]}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ol>
                  <label class="s-field"><span class="s-label">Ajouter une suite</span>
                    <select aria-label="Ajouter une suite" value="" onChange={(ev) => { const v = ev.currentTarget.value; ev.currentTarget.value = ""; if (v !== "") connect(id(), v); }}>
                      <option value="">+ suite vers…</option>
                      <For each={targets()}>{(t) => <option value={t.id}>{t.id === id() ? `${t.label} (boucle)` : t.label}</option>}</For>
                    </select>
                  </label>
                </>
              )}
            </Show>
            <div class="s-row">
              <Button kind="secondary" disabled={!hasSavedPos(id())} onClick={deleteSelected}>Position automatique</Button>
              <span class="muted s-hint"><kbd>Suppr</kbd></span>
            </div>
          </div>
        )}
      </Show>
    );
  }
}

function FlowHelp(): JSX.Element {
  return (
    <div class="s-stack">
      <span class="s-label">Enchaînement</span>
      <p class="muted s-hint">Sans transition, les manches suivent l'ordre de la liste (pointillés). Une transition remplace cet ordre pour sa manche.</p>
      <dl class="s-flow-keys">
        <dt>Glisser ● → manche</dt><dd>créer une transition (sur elle-même : boucle, ex. barrage)</dd>
        <dt>+ SUITE</dt><dd>même chose depuis un menu</dd>
        <dt>Clic sur une flèche</dt><dd>condition, priorité, suppression</dd>
        <dt>Glisser une manche</dt><dd>la déplacer (position enregistrée)</dd>
        <dt>Glisser le fond, molette</dt><dd>se déplacer ; <kbd>Ctrl</kbd> + molette : zoom</dd>
        <dt><kbd>Suppr</kbd></dt><dd>supprimer la flèche / replacer la manche</dd>
        <dt><kbd>Échap</kbd></dt><dd>désélectionner</dd>
      </dl>
    </div>
  );
}
