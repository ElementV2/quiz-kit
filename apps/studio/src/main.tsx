import { For, Match, Show, Switch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { DEMO_GAME, GameDocument } from "@quiz/schema";
import { Button, Panel } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./studio.css";
import { api, type GameSummary } from "./api.ts";
import { ContentEditor } from "./content-editor.tsx";
import { FormatEditor } from "./format-editor.tsx";
import { createHistory } from "./history.ts";
import { ReplayViewer } from "./replay.tsx";
import { SceneEditor } from "./scene-editor.tsx";
import { ThemeEditor } from "./theme-editor.tsx";
import { clone, inField, snapshot, type Update } from "./util.ts";

const TABS = [["content", "Contenu"], ["format", "Format"], ["scenes", "Scènes"], ["theme", "Thème"], ["replay", "Replay"]] as const;
type Tab = (typeof TABS)[number][0];

function App() {
  const [list, { refetch }] = createResource(() => api.list().catch(() => [] as GameSummary[]));
  const [gameId, setGameId] = createSignal<string | null>(null);
  const [game, setGame] = createStore<{ doc: GameDocument }>({ doc: clone(DEMO_GAME) });
  const [tab, setTab] = createSignal<Tab>("content");
  const [msg, setMsg] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const validation = createMemo(() => GameDocument.safeParse(snapshot(game.doc)));
  // Undo / redo of the whole game document (bounded), across every tab.
  const history = createHistory<GameDocument>(100);
  const [histTick, setHistTick] = createSignal(0);
  const update: Update = (f, key) => {
    history.record(clone(game.doc), key, Date.now());
    setGame("doc", produce(f));
    setDirty(true);
    setHistTick((n) => n + 1);
  };
  const restore = (doc: GameDocument | null) => {
    if (doc === null) return;
    setGame("doc", reconcile(doc));
    setDirty(true);
    setHistTick((n) => n + 1);
  };
  const undo = () => restore(history.undo(clone(game.doc)));
  const redo = () => restore(history.redo(clone(game.doc)));
  const canUndo = () => histTick() >= 0 && history.canUndo();
  const canRedo = () => histTick() >= 0 && history.canRedo();
  const load = (doc: GameDocument) => {
    setGame("doc", reconcile(doc));
    history.clear();
    setHistTick((n) => n + 1);
  };

  const open = async (id: string) => {
    const raw = await api.get(id);
    const r = GameDocument.safeParse(raw);
    if (!r.success) {
      setMsg({ ok: false, text: "Partie illisible" });
      return;
    }
    load(r.data);
    setGameId(id);
    setDirty(false);
  };
  const create = () => {
    load({ ...clone(DEMO_GAME), title: "Nouvelle partie" });
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
      setMsg({ ok: r.missing === 0, text: `« ${r.title} » importée (${r.media} média)${r.missing > 0 ? ` · ${r.missing} média(s) référencé(s) absent(s) de l'archive` : ""}` });
      await refetch();
      await open(r.id);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "échec" });
    }
  };
  // Ctrl+S saves (everywhere); Ctrl+Z / Ctrl+Y / Ctrl+Maj+Z undo / redo outside text fields (fields keep their own undo).
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (inField(e) || tab() === "replay") return;
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (k === "y" || (k === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="s-app">
      <header class="s-top">
        <h1>Studio</h1>
        <input class="s-title" aria-label="Titre de la partie" value={game.doc.title} onInput={(e) => { const v = e.currentTarget.value; update((d) => { d.title = v; }, "title"); }} />
        <nav class="s-tabs">
          <For each={TABS}>{([id, label]) => <button type="button" data-on={String(tab() === id)} onClick={() => setTab(id)}>{label}</button>}</For>
        </nav>
        <span class="s-spacer" />
        <div class="s-seg" role="group" aria-label="Historique">
          <button type="button" disabled={!canUndo()} title="Annuler (Ctrl + Z)" onClick={undo}>Annuler</button>
          <button type="button" disabled={!canRedo()} title="Rétablir (Ctrl + Y)" onClick={redo}>Rétablir</button>
        </div>
        <Show when={!validation().success}><span class="s-bad s-problems" title={validation().error?.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("\n")}>⚠ {validation().error?.issues.length} problème(s)</span></Show>
        <Button onClick={() => void save()} title="Ctrl + S">{dirty() ? "Enregistrer •" : "Enregistré"}</Button>
        <Show when={gameId()}>{(id) => <a class="q-btn q-btn-secondary" href={api.exportUrl(id())}>Exporter .quiz</a>}</Show>
      </header>
      <div class="s-body" data-tab={tab()}>
        <aside class="s-library">
          <Panel title="Parties">
            <Button kind="secondary" onClick={create}>+ Nouvelle</Button>
            <label class="s-file q-btn q-btn-ghost">Importer .quiz<input type="file" accept=".quiz,application/zip" onChange={(e) => void importQuiz(e.currentTarget.files?.[0])} /></label>
            <ul class="s-games">
              <For each={list() ?? []}>
                {(g) => (
                  <li data-on={String(g.id === gameId())}>
                    <button type="button" onClick={() => void open(g.id)}>{g.title}</button>
                    <span class="muted q-mono">{g.questions} q.</span>
                  </li>
                )}
              </For>
            </ul>
            <p class="muted s-hint">Lancer une partie en direct : depuis la régie (bibliothèque).</p>
          </Panel>
          <Show when={msg()}>{(m) => <p class={m().ok ? "s-ok" : "s-bad"}>{m().text}</p>}</Show>
        </aside>
        <main class="s-main" data-tab={tab()}>
          <Switch>
            <Match when={tab() === "content"}><ContentEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "format"}><FormatEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "scenes"}><SceneEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "theme"}><ThemeEditor doc={game.doc} update={update} /></Match>
            <Match when={tab() === "replay"}><ReplayViewer /></Match>
          </Switch>
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
