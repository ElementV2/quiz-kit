import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { GameDocument, TEMPLATES } from "@quiz/schema";
import { Button, Panel, isDialogOpen, confirmDialog } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./studio.css";
import { blankGame } from "./question-factories.ts";
import { api, type GameSummary } from "./api.ts";
import { ContentEditor } from "./content-editor.tsx";
import { FormatEditor } from "./format-editor.tsx";
import { createHistory } from "./history.ts";
import { ReplayViewer } from "./replay.tsx";
import { SceneEditor } from "./scene-editor.tsx";
import { ThemeEditor } from "./theme-editor.tsx";
import { clone, inField, snapshot, type Update, hex } from "./util.ts";

const TABS = [["content", "Contenu"], ["format", "Format"], ["scenes", "Scènes"], ["theme", "Thème"], ["replay", "Replay"]] as const;
type Tab = (typeof TABS)[number][0];

function App() {
  const [list, { refetch }] = createResource(() => api.list().catch(() => [] as GameSummary[]));
  const [gameId, setGameId] = createSignal<string | null>(null);
  const [game, setGame] = createStore<{ doc: GameDocument }>({ doc: blankGame(hex(6)) });
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

  /** Unsaved changes are never lost silently: asked before switching game. */
  const leaveCurrent = async (): Promise<boolean> =>
    !dirty() || confirmDialog({ title: "Abandonner les modifications non enregistrées ?", message: `« ${game.doc.title} » a des changements non enregistrés (Ctrl+S pour enregistrer).`, confirm: "Abandonner", cancel: "Rester", danger: true });

  const open = async (id: string) => {
    if (id !== gameId() && !(await leaveCurrent())) return;
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
  /** A new game exists right away: saved to the library, listed and selected (no hidden draft). */
  const create = async (from: GameDocument | null) => {
    setNewMenu(false);
    if (!(await leaveCurrent())) return;
    const id = `g_${Date.now().toString(36)}`;
    const fresh: GameDocument = from === null ? blankGame(hex(6)) : { ...structuredClone(from), title: from.title.replace(/^Modèle — /, "") };
    // On screen at once (typing can start immediately), saved in the background; later edits auto-save.
    load(fresh);
    setGameId(id);
    setDirty(false);
    try {
      await api.save(id, fresh);
      setMsg({ ok: true, text: "Nouvelle partie créée" });
    } catch (e) {
      setDirty(true); // retried by the auto-save
      setMsg({ ok: false, text: `Création non enregistrée : ${e instanceof Error ? e.message : "échec"}` });
    }
    await refetch();
  };
  const [saving, setSaving] = createSignal(false);
  /** `auto`: background save (no message unless it fails, nothing when the game is not valid yet). */
  const save = async (auto = false) => {
    const id = gameId() ?? `g_${Date.now().toString(36)}`;
    const v = validation();
    if (!v.success) {
      if (!auto) setMsg({ ok: false, text: `À corriger avant d'enregistrer : ${v.error.issues[0]?.message ?? "erreur"}` });
      return;
    }
    const version = histTick();
    setSaving(true);
    try {
      await api.save(id, v.data);
      setGameId(id);
      // Edited again while saving: stay dirty, the next auto-save picks it up.
      if (histTick() === version) setDirty(false);
      if (!auto) setMsg({ ok: true, text: "Enregistré" });
      void refetch();
    } catch (e) {
      setMsg({ ok: false, text: `Enregistrement impossible : ${e instanceof Error ? e.message : "échec"}` });
    } finally {
      setSaving(false);
    }
  };
  // Auto-save 1.5 s after the last edit (valid games only): what is on screen is what is in the library.
  createEffect(() => {
    histTick();
    if (!dirty() || gameId() === null) return;
    const t = setTimeout(() => void save(true), 1500);
    onCleanup(() => clearTimeout(t));
  });
  /** Library actions (doc 07): duplicate, delete, export — from the game list itself. */
  const duplicate = async (g: GameSummary) => {
    try {
      const r = GameDocument.safeParse(await api.get(g.id));
      if (!r.success) throw new Error("partie illisible");
      const id = `g_${Date.now().toString(36)}`;
      await api.save(id, { ...r.data, title: `${r.data.title} (copie)`.slice(0, 200) });
      await refetch();
      setMsg({ ok: true, text: `« ${g.title} » dupliquée` });
      await open(id);
    } catch (e) {
      setMsg({ ok: false, text: `Duplication impossible : ${e instanceof Error ? e.message : "échec"}` });
    }
  };
  const removeGame = async (g: GameSummary) => {
    const ok = await confirmDialog({
      title: `Supprimer « ${g.title} » ?`,
      message: "La partie disparaît de la bibliothèque (pas d'annulation : exporter un .quiz avant si besoin). Une partie déjà lancée en régie continue, elle est dans le journal.",
      confirm: "Supprimer la partie",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(g.id);
      if (g.id === gameId()) {
        // The open game is gone: start a fresh one instead of editing a ghost.
        // The open game is gone: show the next one of the library, or nothing to edit until « + Nouvelle ».
        setGameId(null);
        load(blankGame(hex(6)));
        setDirty(false);
      }
      await refetch();
      setMsg({ ok: true, text: `« ${g.title} » supprimée` });
    } catch (e) {
      setMsg({ ok: false, text: `Suppression impossible : ${e instanceof Error ? e.message : "échec"}` });
    }
  };
  let started = false;
  createEffect(() => {
    const games = list();
    if (started || games === undefined) return;
    started = true;
    const recent = games.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent !== undefined) void open(recent.id);
    else void create(null);
  });
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [newMenu, setNewMenu] = createSignal(false);
  /** « Lancer en direct »: saved first, then every screen (control, outputs, host, tablets) switches to it. */
  const launchLive = async () => {
    const id = gameId();
    if (id === null) return;
    if (!validation().success) {
      setMsg({ ok: false, text: "À corriger avant de lancer : la partie a des problèmes (voir ⚠ en haut)." });
      return;
    }
    const ok = await confirmDialog({ title: `Lancer « ${game.doc.title} » en direct ?`, message: "La régie, les sorties OBS / vMix, l'animateur et les tablettes passent sur cette partie. La partie en cours reste dans le journal.", confirm: "Lancer en direct", danger: true });
    if (!ok) return;
    await save();
    try {
      const r = await api.launch(id);
      setMsg({ ok: true, text: `En direct · code joueurs ${r.joinCode}` });
    } catch (e) {
      setMsg({ ok: false, text: `Lancement impossible : ${e instanceof Error ? e.message : "échec"}` });
    }
  };

  const importQuiz = async (f: File | undefined) => {
    if (f === undefined) return;
    if (!(await leaveCurrent())) return;
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
    if (isDialogOpen()) return; // our dialog owns the keyboard (Entrée / Échap)
    if (e.key === "Escape") closeMenu();
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
  const closeMenu = () => {
    setMenuFor(null);
    setNewMenu(false);
  };
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty()) e.preventDefault(); // browser's own "leave page?" (the only case a native prompt is unavoidable)
  };
  onMount(() => {
    window.addEventListener("click", closeMenu);
    window.addEventListener("beforeunload", beforeUnload);
  });
  onCleanup(() => {
    window.removeEventListener("click", closeMenu);
    window.removeEventListener("beforeunload", beforeUnload);
  });
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
        <Button kind={dirty() && !validation().success ? "danger" : "secondary"} onClick={() => void save()} title={dirty() && !validation().success ? "Pas d'enregistrement automatique tant que la partie a des problèmes" : "Enregistrement automatique · Ctrl + S pour forcer"}>{saving() ? "Enregistrement…" : dirty() ? (validation().success ? "Modifications…" : "Non enregistré") : "Enregistré ✓"}</Button>
        <Button kind="secondary" onClick={() => void launchLive()} title="Enregistre puis bascule tous les écrans sur cette partie">Lancer en direct</Button>
        <Show when={gameId()}>{(id) => <a class="q-btn q-btn-secondary" href={api.exportUrl(id())}>Exporter .quiz</a>}</Show>
      </header>
      <div class="s-body" data-tab={tab()}>
        <aside class="s-library">
          <Panel title="Parties">
            <div class="s-new">
              <button type="button" class="q-btn q-btn-secondary s-new-btn" aria-expanded={newMenu()} onClick={(e) => { e.stopPropagation(); setNewMenu(!newMenu()); }}>+ Nouvelle</button>
              <Show when={newMenu()}>
                <div class="s-game-menu s-new-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" role="menuitem" onClick={() => void create(null)}><b>Partie vide</b><span class="muted">une manche, une question à écrire</span></button>
                  <p class="s-menu-label">Depuis un modèle</p>
                  <For each={TEMPLATES}>{(t) => <button type="button" role="menuitem" onClick={() => void create(t.game)}>{t.game.title.replace(/^Modèle — /, "")}</button>}</For>
                </div>
              </Show>
            </div>
            <label class="s-file q-btn q-btn-ghost">Importer .quiz<input type="file" accept=".quiz,application/zip" onChange={(e) => void importQuiz(e.currentTarget.files?.[0])} /></label>
            <ul class="s-games">
              <For each={list() ?? []}>
                {(g) => (
                  <li data-on={String(g.id === gameId())} data-menu={String(menuFor() === g.id)}>
                    <button type="button" class="s-game-open" title={g.title} onClick={() => void open(g.id)}>{g.title}</button>
                    <span class="muted q-mono">{g.questions} q.</span>
                    <button type="button" class="s-game-more" aria-label={`Actions pour « ${g.title} »`} aria-expanded={menuFor() === g.id} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor() === g.id ? null : g.id); }}>⋯</button>
                    <Show when={menuFor() === g.id}>
                      <div class="s-game-menu" role="menu" onClick={() => setMenuFor(null)}>
                        <button type="button" role="menuitem" onClick={() => void open(g.id)}>Ouvrir</button>
                        <button type="button" role="menuitem" onClick={() => void duplicate(g)}>Dupliquer</button>
                        <a role="menuitem" href={api.exportUrl(g.id)}>Exporter .quiz</a>
                        <button type="button" role="menuitem" class="s-game-danger" onClick={() => void removeGame(g)}>Supprimer…</button>
                      </div>
                    </Show>
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
