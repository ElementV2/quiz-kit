import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { render } from "solid-js/web";
import { DEFAULT_THEME, DEMO_GAME, GameDocument, OUTPUT_SCENES, ZoneState, ZoneType, parseQuestionsCsv, type Layer, type Question, type Scene, type Theme, type Zone } from "@quiz/schema";
import { SceneRenderer, generateThemes, layerVisible } from "@quiz/renderer";
import { Button, Panel } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./studio.css";
import { api, download, imageSize, mediaUrl, svgToPng, type GameSummary } from "./api.ts";
import { SAFE_AREAS, SIMULATED_PHASES, assetSheetCsv, clampRect, deriveStates, longestText, matchDeliveredAssets, outsideSafe, simulateView, templateSvg, type SimulatedPhase } from "./studio-logic.ts";

const hex = (n: number): string => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
/** Untracked deep copy (for writes: reconcile, structuredClone of presets). */
const clone = <T,>(v: T): T => structuredClone(unwrap(v));
/**
 * TRACKED deep copy: reads every property through the store proxy, so memos depending on it re-run on any edit.
 * (`unwrap` bypasses tracking: a memo built on it would keep validating — and saving — the first version.)
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON round-trip of a JSON document keeps its type
const snapshot = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Tab = "content" | "scenes" | "theme";

function App() {
  const [list, { refetch }] = createResource(() => api.list().catch(() => [] as GameSummary[]));
  const [gameId, setGameId] = createSignal<string | null>(null);
  const [game, setGame] = createStore<{ doc: GameDocument }>({ doc: clone(DEMO_GAME) });
  const [tab, setTab] = createSignal<Tab>("content");
  const [msg, setMsg] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const validation = createMemo(() => GameDocument.safeParse(snapshot(game.doc)));
  const update = (f: (d: GameDocument) => void) => {
    setGame("doc", produce(f));
    setDirty(true);
  };

  const open = async (id: string) => {
    const raw = await api.get(id);
    const r = GameDocument.safeParse(raw);
    if (!r.success) {
      setMsg({ ok: false, text: "Partie illisible" });
      return;
    }
    setGame("doc", reconcile(r.data));
    setGameId(id);
    setDirty(false);
  };
  const create = () => {
    setGame("doc", reconcile({ ...clone(DEMO_GAME), title: "Nouvelle partie" }));
    setGameId(`g_${Date.now().toString(36)}`);
    setDirty(true);
  };
  const save = async () => {
    const id = gameId() ?? `g_${Date.now().toString(36)}`;
    const v = validation();
    if (!v.success) {
      setMsg({ ok: false, text: `À corriger avant d'enregistrer : ${v.error.issues[0]?.message ?? "erreur"}` });
      return;
    }
    try {
      await api.save(id, v.data);
      setGameId(id);
      setDirty(false);
      setMsg({ ok: true, text: "Enregistré" });
      void refetch();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "échec" });
    }
  };
  const importQuiz = async (f: File | undefined) => {
    if (f === undefined) return;
    try {
      const r = await api.importQuiz(f);
      setMsg({ ok: true, text: `« ${r.title} » importée (${r.media} média)` });
      await refetch();
      await open(r.id);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "échec" });
    }
  };
  // Ctrl+S saves.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="s-app">
      <header class="s-top">
        <h1>Studio</h1>
        <input class="s-title" value={game.doc.title} onInput={(e) => update((d) => { d.title = e.currentTarget.value; })} />
        <nav class="s-tabs">
          <button type="button" data-on={String(tab() === "content")} onClick={() => setTab("content")}>Contenu</button>
          <button type="button" data-on={String(tab() === "scenes")} onClick={() => setTab("scenes")}>Scènes</button>
          <button type="button" data-on={String(tab() === "theme")} onClick={() => setTab("theme")}>Thème</button>
        </nav>
        <span class="s-spacer" />
        <Show when={!validation().success}><span class="s-bad" title={validation().error?.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("\n")}>⚠ {validation().error?.issues.length} problème(s)</span></Show>
        <Button onClick={() => void save()} title="Ctrl+S">{dirty() ? "Enregistrer •" : "Enregistré"}</Button>
        <Show when={gameId()}>{(id) => <a class="q-btn q-btn-secondary" href={api.exportUrl(id())}>Exporter .quiz</a>}</Show>
      </header>
      <div class="s-body">
        <aside class="s-library">
          <Panel title="Parties">
            <Button kind="secondary" onClick={create}>+ Nouvelle</Button>
            <label class="s-file q-btn q-btn-ghost">Importer .quiz<input type="file" accept=".quiz,application/zip" onChange={(e) => void importQuiz(e.currentTarget.files?.[0])} /></label>
            <ul class="s-games">
              <For each={list() ?? []}>
                {(g) => (
                  <li data-on={String(g.id === gameId())}>
                    <button type="button" onClick={() => void open(g.id)}>{g.title}</button>
                    <span class="muted">{g.questions} q.</span>
                  </li>
                )}
              </For>
            </ul>
            <p class="muted s-hint">Lancer une partie en direct : depuis la régie (bibliothèque).</p>
          </Panel>
          <Show when={msg()}>{(m) => <p class={m().ok ? "s-ok" : "s-bad"}>{m().text}</p>}</Show>
        </aside>
        <main class="s-main">
          <Switch>
            <Match when={tab() === "content"}><ContentEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "scenes"}><SceneEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "theme"}><ThemeEditor doc={game.doc} update={update} /></Match>
          </Switch>
        </main>
      </div>
    </div>
  );
}

// ───────────────────────────── Contenu ─────────────────────────────

const LETTERS = ["a", "b", "c", "d", "e", "f"] as const;

function syncRound(d: GameDocument): void {
  // Phase 2: one round holds every question (the Format mode arrives in phase 3).
  const round = d.format.rounds[0];
  if (round !== undefined) round.questions = d.questions.map((q) => q.id);
}

function ContentEditor(p: { doc: GameDocument; update: (f: (d: GameDocument) => void) => void }) {
  const [paste, setPaste] = createSignal("");
  const pasted = createMemo(() => parseQuestionsCsv(paste()));
  const add = (kind: "single" | "boolean") =>
    p.update((d) => {
      const q: Question = kind === "single"
        ? { id: `q_${hex(6)}`, prompt: { text: "Nouvelle question ?" }, answerSpec: { kind: "single", correct: "a", options: [{ id: "a", label: "Réponse A" }, { id: "b", label: "Réponse B" }] }, hints: [], tags: [] }
        : { id: `q_${hex(6)}`, prompt: { text: "Affirmation ?" }, answerSpec: { kind: "boolean", correct: true }, hints: [], tags: [] };
      d.questions.push(q);
      syncRound(d);
    });
  const importPaste = () =>
    p.update((d) => {
      for (const q of pasted().questions) d.questions.push({ ...q, id: `q_${hex(6)}` });
      syncRound(d);
      setPaste("");
    });
  const attach = async (qi: number, f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    p.update((d) => {
      const q = d.questions[qi];
      if (q !== undefined) q.prompt.media = m;
    });
  };
  return (
    <div class="s-content">
      <div class="s-row">
        <Button onClick={() => add("single")}>+ QCM</Button>
        <Button kind="secondary" onClick={() => add("boolean")}>+ Vrai / faux</Button>
        <span class="muted">{p.doc.questions.length} question(s) · chrono {Math.round((p.doc.format.rounds[0]?.timer?.durationMs ?? 0) / 1000)} s</span>
        <label class="muted">Chrono (s) <input class="s-num" type="number" min="5" value={Math.round((p.doc.format.rounds[0]?.timer?.durationMs ?? 20000) / 1000)} onChange={(e) => p.update((d) => { const r = d.format.rounds[0]; if (r !== undefined) r.timer = { durationMs: Math.max(5, Number(e.currentTarget.value) || 20) * 1000, autoLock: true }; })} /></label>
      </div>
      <table class="s-table">
        <thead><tr><th>#</th><th>Question</th><th>Réponses (cocher la bonne)</th><th>Média</th><th>Notes animateur</th><th /></tr></thead>
        <tbody>
          <For each={p.doc.questions}>
            {(q, i) => (
              <tr>
                <td>{i() + 1}</td>
                <td><textarea rows={2} value={q.prompt.text} onInput={(e) => p.update((d) => { const x = d.questions[i()]; if (x !== undefined) x.prompt.text = e.currentTarget.value; })} /></td>
                <td>
                  <Switch>
                    <Match when={q.answerSpec.kind === "boolean"}>
                      <label><input type="radio" checked={q.answerSpec.kind === "boolean" && q.answerSpec.correct} onChange={() => p.update((d) => { const s = d.questions[i()]?.answerSpec; if (s?.kind === "boolean") s.correct = true; })} /> Vrai</label>{" "}
                      <label><input type="radio" checked={q.answerSpec.kind === "boolean" && !q.answerSpec.correct} onChange={() => p.update((d) => { const s = d.questions[i()]?.answerSpec; if (s?.kind === "boolean") s.correct = false; })} /> Faux</label>
                    </Match>
                    <Match when={q.answerSpec.kind === "single" || q.answerSpec.kind === "multi"}>
                      <div class="s-opts">
                        <For each={"options" in q.answerSpec ? q.answerSpec.options : []}>
                          {(o, oi) => {
                            const isCorrect = () => (q.answerSpec.kind === "single" ? q.answerSpec.correct === o.id : q.answerSpec.kind === "multi" && q.answerSpec.correct.includes(o.id));
                            return (
                              <div class="s-opt">
                                <input type="checkbox" checked={isCorrect()} title="bonne réponse" onChange={(e) => p.update((d) => {
                                  const s = d.questions[i()]?.answerSpec;
                                  if (s?.kind === "single") {
                                    if (e.currentTarget.checked) s.correct = o.id;
                                  } else if (s?.kind === "multi") {
                                    s.correct = e.currentTarget.checked ? [...new Set([...s.correct, o.id])] : s.correct.filter((c) => c !== o.id);
                                  }
                                })} />
                                <input value={o.label} onInput={(e) => p.update((d) => { const s = d.questions[i()]?.answerSpec; if (s !== undefined && "options" in s) { const x = s.options[oi()]; if (x !== undefined) x.label = e.currentTarget.value; } })} />
                              </div>
                            );
                          }}
                        </For>
                        <Show when={"options" in q.answerSpec && q.answerSpec.options.length < 6}>
                          <Button kind="ghost" onClick={() => p.update((d) => { const s = d.questions[i()]?.answerSpec; if (s !== undefined && "options" in s) { const id = LETTERS.find((l) => !s.options.some((o) => o.id === l)) ?? "f"; s.options.push({ id, label: `Réponse ${id.toUpperCase()}` }); } })}>+ réponse</Button>
                        </Show>
                        <label class="muted"><input type="checkbox" checked={q.answerSpec.kind === "multi"} onChange={(e) => p.update((d) => {
                          const x = d.questions[i()];
                          if (x === undefined || !("options" in x.answerSpec)) return;
                          const opts = x.answerSpec.options;
                          x.answerSpec = e.currentTarget.checked
                            ? { kind: "multi", options: opts, correct: [x.answerSpec.kind === "single" ? x.answerSpec.correct : (opts[0]?.id ?? "a")] }
                            : { kind: "single", options: opts, correct: x.answerSpec.kind === "multi" ? (x.answerSpec.correct[0] ?? "a") : "a" };
                        })} /> plusieurs bonnes réponses</label>
                      </div>
                    </Match>
                  </Switch>
                </td>
                <td>
                  <Show when={q.prompt.media} fallback={<label class="q-btn q-btn-ghost s-file">Ajouter<input type="file" accept="image/*,video/*,audio/*" onChange={(e) => void attach(i(), e.currentTarget.files?.[0])} /></label>}>
                    {(m) => (
                      <div class="s-media">
                        <Show when={m().mime.startsWith("image/")} fallback={<span>{m().mime.split("/")[0] === "audio" ? "♪ son" : "▶ vidéo"}</span>}><img src={mediaUrl(m().hash)} alt="" /></Show>
                        <Button kind="ghost" onClick={() => p.update((d) => { const x = d.questions[i()]; if (x !== undefined) delete x.prompt.media; })}>retirer</Button>
                      </div>
                    )}
                  </Show>
                </td>
                <td><textarea rows={2} value={q.notes ?? ""} onInput={(e) => p.update((d) => { const x = d.questions[i()]; if (x !== undefined) x.notes = e.currentTarget.value; })} /></td>
                <td class="s-actions">
                  <Button kind="ghost" disabled={i() === 0} onClick={() => p.update((d) => { const [x] = d.questions.splice(i(), 1); if (x !== undefined) d.questions.splice(i() - 1, 0, x); syncRound(d); })}>↑</Button>
                  <Button kind="ghost" disabled={p.doc.questions.length <= 1} onClick={() => p.update((d) => { d.questions.splice(i(), 1); syncRound(d); })}>✕</Button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Panel title="Coller depuis Excel / Sheets / CSV (type ; question ; A … F ; réponse ; notes)">
        <textarea class="s-paste" rows={4} value={paste()} onInput={(e) => setPaste(e.currentTarget.value)} />
        <div class="s-row">
          <Button disabled={pasted().questions.length === 0} onClick={importPaste}>Ajouter {pasted().questions.length} question(s)</Button>
          <Show when={pasted().errors.length > 0}><span class="s-bad">{pasted().errors.slice(0, 3).join(" · ")}</span></Show>
        </div>
      </Panel>
    </div>
  );
}

// ───────────────────────────── Scènes ─────────────────────────────

const PHASE_LABEL: Record<SimulatedPhase, string> = { idle: "Entre deux questions", presenting: "Question présentée", open: "Réponses ouvertes", locked: "Réponses fermées", revealed: "Réponse révélée", "game.end": "Fin de partie" };

function SceneEditor(p: { doc: GameDocument; update: (f: (d: GameDocument) => void) => void }) {
  const [sceneIdx, setSceneIdx] = createSignal(0);
  const [phase, setPhase] = createSignal<SimulatedPhase>("revealed");
  const [qIndex, setQIndex] = createSignal(0);
  const [sel, setSel] = createSignal<{ layer: number; zone: number } | null>(null);
  const [refHash, setRefHash] = createSignal<string | null>(null);
  const [refOpacity, setRefOpacity] = createSignal(0.5);
  const [report, setReport] = createSignal<string | null>(null);
  const [scale, setScale] = createSignal(0.5);
  let box: HTMLDivElement | undefined;
  onMount(() => {
    if (box === undefined) return;
    const el = box;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1920));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  const ensureScenes = () => p.update((d) => { if (d.scenes.length === 0) d.scenes = Object.values(OUTPUT_SCENES).map((s) => structuredClone(s)); });
  const scene = (): Scene | undefined => p.doc.scenes[sceneIdx()];
  const view = createMemo(() => {
    const v = GameDocument.safeParse(snapshot(p.doc));
    return v.success ? simulateView(v.data, phase(), qIndex()) : null;
  });
  const selectedZone = (): Zone | undefined => {
    const s = sel();
    return s === null ? undefined : scene()?.layers[s.layer]?.zones[s.zone];
  };
  const editZone = (f: (z: Zone) => void) => p.update((d) => {
    const s = sel();
    const z = s === null ? undefined : d.scenes[sceneIdx()]?.layers[s.layer]?.zones[s.zone];
    if (z !== undefined) f(z);
  });
  const addZone = (type: Zone["type"]) => p.update((d) => {
    const sc = d.scenes[sceneIdx()];
    if (sc === undefined) return;
    if (sc.layers.length === 0) sc.layers.push({ id: "set", name: "Plateau", z: 10, mode: "auto", phases: [], zones: [] });
    const li = sel()?.layer ?? 0;
    const layer = sc.layers[li] ?? sc.layers[0];
    if (layer === undefined) return;
    layer.zones.push({ id: `${type}-${hex(2)}`, type, rect: { x: 760, y: 440, w: 400, h: 200 }, props: {}, style: {}, states: {} });
    setSel({ layer: sc.layers.indexOf(layer), zone: layer.zones.length - 1 });
  });

  // Drag (move) or resize with pointer events, snapped to the grid and clamped to the canvas.
  const startDrag = (e: PointerEvent, li: number, zi: number, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    setSel({ layer: li, zone: zi });
    const z = scene()?.layers[li]?.zones[zi];
    if (z === undefined) return;
    const start = { x: e.clientX, y: e.clientY, rect: { ...z.rect } };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale();
      const dy = (ev.clientY - start.y) / scale();
      const r = mode === "move" ? { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy } : { ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy };
      editZone((zz) => { zz.rect = clampRect(r, scene()?.size ?? { w: 1920, h: 1080 }); });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const exportTemplate = async (kind: "svg" | "png" | "csv") => {
    const sc = scene();
    const v = GameDocument.safeParse(snapshot(p.doc));
    if (sc === undefined || !v.success) return;
    const svg = templateSvg(sc, v.data);
    if (kind === "svg") download(`gabarit-${sc.id}.svg`, svg, "image/svg+xml");
    else if (kind === "csv") download(`assets-${sc.id}.csv`, assetSheetCsv(sc), "text/csv");
    else download(`gabarit-${sc.id}.png`, await svgToPng(svg, sc.size.w, sc.size.h));
  };
  const reimport = async (files: FileList | null) => {
    const sc = scene();
    if (files === null || sc === undefined) return;
    const list = await Promise.all([...files].map(async (f) => ({ f, ...(await imageSize(f).catch(() => ({ w: 0, h: 0 }))) })));
    const r = matchDeliveredAssets(sc, list.map((x) => ({ name: x.f.name, w: x.w, h: x.h })));
    for (const m of r.matched) {
      const file = list.find((x) => x.f.name === m.file)?.f;
      if (file === undefined) continue;
      const media = await api.upload(file);
      const state = ZoneState.safeParse(m.state);
      if (!state.success) continue;
      p.update((d) => {
        for (const l of d.scenes[sceneIdx()]?.layers ?? []) {
          for (const z of l.zones) {
            if (z.id === m.zone) z.states[state.data] = { ...z.states[state.data], "background-image": `url(${mediaUrl(media.hash)})`, "background-size": "100% 100%" };
          }
        }
      });
    }
    setReport(`${r.matched.length} appliqué(s) · ${r.missing.length} manquant(s)${r.wrongSize.length > 0 ? ` · mauvaise taille : ${r.wrongSize.join(", ")}` : ""}${r.unknown.length > 0 ? ` · inconnus : ${r.unknown.join(", ")}` : ""}`);
  };
  const uploadRef = async (f: File | undefined) => {
    if (f === undefined) return;
    setRefHash((await api.upload(f)).hash);
  };

  return (
    <Show when={p.doc.scenes.length > 0} fallback={<Panel title="Scènes"><p>Cette partie utilise les scènes intégrées.</p><Button onClick={ensureScenes}>Personnaliser les scènes</Button></Panel>}>
      <div class="s-scenes">
        <div class="s-canvas-col">
          <div class="s-row">
            <select value={sceneIdx()} onChange={(e) => { setSceneIdx(Number(e.currentTarget.value)); setSel(null); }}>
              <For each={p.doc.scenes}>{(s, i) => <option value={i()}>{s.name} ({s.id})</option>}</For>
            </select>
            <select value={phase()} onChange={(e) => setPhase(e.currentTarget.value as SimulatedPhase)}> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- options are SIMULATED_PHASES */}
              <For each={SIMULATED_PHASES}>{(ph) => <option value={ph}>Simuler : {PHASE_LABEL[ph]}</option>}</For>
            </select>
            <label class="muted">Question <input class="s-num" type="number" min="1" max={p.doc.questions.length} value={qIndex() + 1} onInput={(e) => setQIndex(Math.max(0, Math.min(p.doc.questions.length - 1, Number(e.currentTarget.value) - 1)))} /></label>
            <label class="q-btn q-btn-ghost s-file">Calque de référence<input type="file" accept="image/*" onChange={(e) => void uploadRef(e.currentTarget.files?.[0])} /></label>
            <Show when={refHash()}><input type="range" min="0" max="1" step="0.05" value={refOpacity()} onInput={(e) => setRefOpacity(Number(e.currentTarget.value))} title="opacité de la référence" /></Show>
          </div>
          <div ref={box} class="s-canvas" style={{ "--s": String(scale()) }} onPointerDown={() => setSel(null)}>
            <div class="s-stage">
              <Show when={refHash()}>{(h) => <img class="s-ref" src={mediaUrl(h())} alt="" style={{ opacity: refOpacity() }} />}</Show>
              <Show when={scene()}>{(sc) => <SceneRenderer scene={sc()} theme={p.doc.theme ?? DEFAULT_THEME} view={view()} serverNow={() => Date.now()} />}</Show>
              <div class="s-safe s-safe-action" style={{ left: `${SAFE_AREAS.action.x}px`, top: `${SAFE_AREAS.action.y}px`, width: `${SAFE_AREAS.action.w}px`, height: `${SAFE_AREAS.action.h}px` }} />
              <div class="s-safe s-safe-graphics" style={{ left: `${SAFE_AREAS.graphics.x}px`, top: `${SAFE_AREAS.graphics.y}px`, width: `${SAFE_AREAS.graphics.w}px`, height: `${SAFE_AREAS.graphics.h}px` }} />
              <For each={scene()?.layers ?? []}>
                {(l, li) => (
                  <For each={l.zones}>
                    {(z, zi) => (
                      <div class="s-zone" data-sel={String(sel()?.layer === li() && sel()?.zone === zi())} data-warn={String(outsideSafe(z))} data-off={String(!layerVisible(l, view()?.phase ?? "idle", {}) && sel()?.layer !== li())} style={{ left: `${z.rect.x}px`, top: `${z.rect.y}px`, width: `${z.rect.w}px`, height: `${z.rect.h}px` }} onPointerDown={(e) => startDrag(e, li(), zi(), "move")}>
                        <span class="s-zone-label">{z.id}</span>
                        <span class="s-handle" onPointerDown={(e) => startDrag(e, li(), zi(), "resize")} />
                      </div>
                    )}
                  </For>
                )}
              </For>
            </div>
          </div>
          <div class="s-row">
            <span class="muted">Ajouter une zone :</span>
            <For each={ZoneType.options}>{(t) => <Button kind="secondary" onClick={() => addZone(t)}>{t}</Button>}</For>
          </div>
          <Panel title="Gabarit pour le graphiste">
            <div class="s-row">
              <Button kind="secondary" onClick={() => void exportTemplate("svg")}>Gabarit SVG</Button>
              <Button kind="secondary" onClick={() => void exportTemplate("png")}>Gabarit PNG</Button>
              <Button kind="secondary" onClick={() => void exportTemplate("csv")}>Fiche assets (CSV)</Button>
              <label class="q-btn s-file">Réimporter les assets livrés<input type="file" multiple accept="image/png" onChange={(e) => void reimport(e.currentTarget.files)} /></label>
            </div>
            <p class="muted">Convention : <code>&lt;zone&gt;_&lt;état&gt;@2x.png</code>, un fichier par état (pas par case).</p>
            <Show when={report()}>{(r) => <p>{r()}</p>}</Show>
          </Panel>
        </div>
        <aside class="s-inspector">
          <LayersPanel scene={scene()} sel={sel()} onSelect={(li) => setSel({ layer: li, zone: -1 })} update={(f) => p.update((d) => { const sc = d.scenes[sceneIdx()]; if (sc !== undefined) f(sc); })} />
          <Show when={selectedZone()} fallback={<Panel title="Inspecteur"><p class="muted">Sélectionner une zone sur le canevas.</p></Panel>}>
            {(z) => <ZoneInspector zone={z()} doc={p.doc} refHash={refHash()} edit={editZone} remove={() => p.update((d) => { const s = sel(); if (s !== null) d.scenes[sceneIdx()]?.layers[s.layer]?.zones.splice(s.zone, 1); setSel(null); })} />}
          </Show>
        </aside>
      </div>
    </Show>
  );
}

const PHASES_ALL = ["lobby", "idle", "presenting", "open", "locked", "judging", "revealed", "round.end", "game.end"] as const;

function LayersPanel(p: { scene: Scene | undefined; sel: { layer: number; zone: number } | null; onSelect: (li: number) => void; update: (f: (s: Scene) => void) => void }) {
  return (
    <Panel title="Couches">
      <For each={p.scene?.layers ?? []}>
        {(l: Layer, li) => (
          <div class="s-layer" data-sel={String(p.sel?.layer === li())} onClick={() => p.onSelect(li())}>
            <div class="s-row">
              <input value={l.name} onInput={(e) => p.update((s) => { const x = s.layers[li()]; if (x !== undefined) x.name = e.currentTarget.value; })} />
              <input class="s-num" type="number" value={l.z} title="ordre (z)" onInput={(e) => p.update((s) => { const x = s.layers[li()]; if (x !== undefined) x.z = Number(e.currentTarget.value) || 0; })} />
              <select value={l.mode} onChange={(e) => p.update((s) => { const x = s.layers[li()]; if (x !== undefined) x.mode = e.currentTarget.value === "manual" ? "manual" : e.currentTarget.value === "auto-hold" ? "auto-hold" : "auto"; })}>
                <option value="auto">auto</option>
                <option value="manual">manuel (TAKE)</option>
                <option value="auto-hold">auto-hold</option>
              </select>
            </div>
            <div class="s-phases">
              <For each={PHASES_ALL}>
                {(ph) => <label><input type="checkbox" checked={l.phases.includes(ph)} onChange={(e) => p.update((s) => { const x = s.layers[li()]; if (x !== undefined) x.phases = e.currentTarget.checked ? [...x.phases, ph] : x.phases.filter((y) => y !== ph); })} />{ph}</label>}
              </For>
            </div>
          </div>
        )}
      </For>
      <Button kind="ghost" onClick={() => p.update((s) => { s.layers.push({ id: `layer-${hex(2)}`, name: "Nouvelle couche", z: 40, mode: "auto", phases: [], zones: [] }); })}>+ couche</Button>
      <p class="muted s-hint">Repères : fond 0, plateau 10, scores 20, classement 30, infos 40, chrono 50, plein écran 90.</p>
    </Panel>
  );
}

function JsonField(p: { label: string; value: unknown; onChange: (v: Record<string, unknown>) => void }) {
  const [text, setText] = createSignal(JSON.stringify(p.value, null, 1));
  const [bad, setBad] = createSignal(false);
  createEffect(() => setText(JSON.stringify(p.value, null, 1)));
  return (
    <label class="s-json">
      {p.label}
      <textarea rows={3} data-bad={String(bad())} value={text()} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => {
        try {
          const v: unknown = JSON.parse(text());
          if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("objet attendu");
          setBad(false);
          p.onChange(Object.fromEntries(Object.entries(v)));
        } catch {
          setBad(true);
        }
      }} />
    </label>
  );
}

function ZoneInspector(p: { zone: Zone; doc: GameDocument; refHash: string | null; edit: (f: (z: Zone) => void) => void; remove: () => void }) {
  const longest = () => longestText(p.doc, p.zone);
  const nine = () => ({ t: Number(p.zone.props["nineTop"] ?? 0), r: Number(p.zone.props["nineRight"] ?? 0), b: Number(p.zone.props["nineBottom"] ?? 0), l: Number(p.zone.props["nineLeft"] ?? 0) });
  const applyNine = async (f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    const n = nine();
    p.edit((z) => {
      z.style["border-style"] = "solid";
      z.style["border-width"] = `${n.t}px ${n.r}px ${n.b}px ${n.l}px`;
      z.style["border-image"] = `url(${mediaUrl(m.hash)}) ${n.t} ${n.r} ${n.b} ${n.l} fill / ${n.t}px ${n.r}px ${n.b}px ${n.l}px stretch`;
    });
  };
  return (
    <Panel title={`Zone « ${p.zone.id} » · ${p.zone.type}`}>
      <div class="s-grid4">
        <For each={["x", "y", "w", "h"] as const}>
          {(k) => <label>{k}<input class="s-num" type="number" value={p.zone.rect[k]} onChange={(e) => p.edit((z) => { z.rect = clampRect({ ...z.rect, [k]: Number(e.currentTarget.value) }, { w: 1920, h: 1080 }); })} /></label>}
        </For>
      </div>
      <Show when={outsideSafe(p.zone)}><p class="s-bad">Hors zone de sécurité graphique (EBU R 95).</p></Show>
      <label>Identifiant <input value={p.zone.id} onChange={(e) => p.edit((z) => { z.id = e.currentTarget.value.toLowerCase().replaceAll(/[^0-9a-z-]/g, "-"); })} /></label>
      <label>Binding <input placeholder="question.prompt.text" value={p.zone.bind ?? ""} onChange={(e) => p.edit((z) => { if (e.currentTarget.value === "") delete z.bind; else z.bind = e.currentTarget.value; })} /></label>
      <Show when={longest().length > 0}><p class="muted">Texte le plus long ({longest().length} car.) : « {longest().slice(0, 80)} »</p></Show>
      <JsonField label="Options (props)" value={p.zone.props} onChange={(v) => p.edit((z) => { z.props = Object.fromEntries(Object.entries(v).filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]))); })} />
      <JsonField label="Style (CSS)" value={p.zone.style} onChange={(v) => p.edit((z) => { z.style = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])); })} />
      <JsonField label="États (style par état)" value={p.zone.states} onChange={(v) => p.edit((z) => { z.states = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "object" && x !== null).map(([k, x]) => [k, Object.fromEntries(Object.entries(x as object).map(([a, b]) => [a, String(b)]))])); })} /> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- filtered to objects above */}
      <div class="s-row">
        <Button kind="secondary" onClick={() => p.edit((z) => { z.states = deriveStates(z); })}>Dériver les états manquants</Button>
        <Show when={p.refHash}>{(h) => <Button kind="secondary" onClick={() => p.edit((z) => { z.style["background-image"] = `url(${mediaUrl(h())})`; z.style["background-size"] = "1920px 1080px"; z.style["background-position"] = `-${z.rect.x}px -${z.rect.y}px`; })}>Découper le fond depuis la référence</Button>}</Show>
      </div>
      <details>
        <summary>Cadre extensible (9-slice)</summary>
        <div class="s-grid4">
          <For each={[["nineTop", "haut"], ["nineRight", "droite"], ["nineBottom", "bas"], ["nineLeft", "gauche"]] as const}>
            {([k, label]) => <label>{label}<input class="s-num" type="number" min="0" value={Number(p.zone.props[k] ?? 0)} onChange={(e) => p.edit((z) => { z.props[k] = Number(e.currentTarget.value) || 0; })} /></label>}
          </For>
        </div>
        <label class="q-btn q-btn-secondary s-file">Image du cadre…<input type="file" accept="image/*" onChange={(e) => void applyNine(e.currentTarget.files?.[0])} /></label>
      </details>
      <Button kind="danger" onClick={p.remove}>Supprimer la zone</Button>
    </Panel>
  );
}

// ───────────────────────────── Thème ─────────────────────────────

const COLOR_LABELS: Record<keyof Theme["colors"], string> = { surface: "Fond des cadres", surfaceAlt: "Fond secondaire", text: "Texte", muted: "Texte secondaire", primary: "Primaire", accent: "Accent", correct: "Bonne réponse", wrong: "Mauvaise réponse", selected: "Sélection" };

function ThemeEditor(p: { doc: GameDocument; update: (f: (d: GameDocument) => void) => void }) {
  const theme = (): Theme => p.doc.theme ?? DEFAULT_THEME;
  const [c1, setC1] = createSignal(theme().colors.primary);
  const [c2, setC2] = createSignal(theme().colors.accent);
  const variants = createMemo(() => generateThemes(c1(), c2(), theme().font.family));
  const set = (f: (t: Theme) => void) => p.update((d) => { if (d.theme === undefined) d.theme = structuredClone(DEFAULT_THEME); f(d.theme); });
  const view = createMemo(() => {
    const v = GameDocument.safeParse(snapshot(p.doc));
    return v.success ? simulateView(v.data, "revealed") : null;
  });
  return (
    <div class="s-theme">
      <Panel title="Générer depuis 2 couleurs">
        <div class="s-row">
          <label>Couleur 1 <input type="color" value={c1()} onInput={(e) => setC1(e.currentTarget.value)} /></label>
          <label>Couleur 2 <input type="color" value={c2()} onInput={(e) => setC2(e.currentTarget.value)} /></label>
        </div>
        <div class="s-variants">
          <For each={variants()}>
            {(v) => (
              <div class="s-variant">
                <div class="s-swatches"><For each={Object.values(v.theme.colors)}>{(c) => <span style={{ background: c }} />}</For></div>
                <b>{v.theme.name}</b>
                <ul><For each={v.report}>{(r) => <li data-ok={String(r.ok)}>{r.ok ? "✓" : "✗"} {r.label} {r.ratio}:1</li>}</For></ul>
                <Button onClick={() => p.update((d) => { d.theme = structuredClone(v.theme); })}>Appliquer</Button>
              </div>
            )}
          </For>
        </div>
      </Panel>
      <Panel title="Réglages fins">
        <div class="s-colors">
          <For each={Object.keys(COLOR_LABELS) as (keyof Theme["colors"])[]}>{/* oxlint-disable-line typescript/no-unsafe-type-assertion -- keys of a literal record */}
            {(k) => <label><input type="color" value={theme().colors[k].slice(0, 7)} onInput={(e) => set((t) => { t.colors[k] = e.currentTarget.value; })} /> {COLOR_LABELS[k]}</label>}
          </For>
        </div>
        <label>Police <input value={theme().font.family} onChange={(e) => set((t) => { t.font.family = e.currentTarget.value; })} /></label>
        <label>Arrondis <input type="range" min="0" max="40" value={theme().radius} onInput={(e) => set((t) => { t.radius = Number(e.currentTarget.value); })} /> {theme().radius}px</label>
        <label>Mouvement <select value={theme().motion} onChange={(e) => set((t) => { const m = e.currentTarget.value; t.motion = m === "elegant" || m === "bouncy" || m === "dramatic" ? m : "snappy"; })}>
          <option value="snappy">vif</option><option value="elegant">élégant</option><option value="bouncy">rebond</option><option value="dramatic">dramatique</option>
        </select></label>
      </Panel>
      <Panel title="Aperçu (programme, réponse révélée)">
        <div class="s-mini"><SceneRenderer scene={p.doc.scenes.find((s) => s.id === "program") ?? OUTPUT_SCENES["program"] ?? (p.doc.scenes[0] as Scene)} theme={theme()} view={view()} serverNow={() => Date.now()} fit /></div> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- presets always contain program */}
      </Panel>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
