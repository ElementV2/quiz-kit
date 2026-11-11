import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js";
import { defaultRegistry, project, type Game } from "@quiz/engine";
import { DEFAULT_THEME, Event, OUTPUT_SCENES, Session, type Scene } from "@quiz/schema";
import { SceneRenderer } from "@quiz/renderer";
import { Button, Panel } from "@quiz/ui";
import { api } from "./api.ts";
import { actorLabel, clock, createReplayCursor, type ReplayCursor } from "./replay-logic.ts";

type Loaded = { session: Session; events: Event[]; cursor: ReplayCursor };

/** Replay from the journal (doc 09): read-only, the engine re-folds the journal locally step by step. */
export function ReplayViewer(): JSX.Element {
  const [loaded, setLoaded] = createSignal<Loaded | null>(null);
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [step, setStep] = createSignal(0);
  const [sceneId, setSceneId] = createSignal("program");

  const load = async () => {
    setStatus({ ok: true, text: "Chargement du journal…" });
    try {
      const raw = await api.journal((n, last) => setStatus({ ok: true, text: `Chargement du journal… ${n} / ${last}` }));
      const session = Session.safeParse(raw.session);
      if (!session.success) throw new Error("session illisible");
      const events: Event[] = [];
      for (const e of raw.events) {
        const r = Event.safeParse(e);
        if (!r.success) throw new Error(`événement illisible (position ${events.length + 1})`);
        events.push(r.data);
      }
      setLoaded({ session: session.data, events, cursor: createReplayCursor(session.data, events, defaultRegistry) });
      setStep(events.length);
      setStatus(null);
    } catch (e) {
      setStatus({ ok: false, text: `Journal indisponible : ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  onMount(() => void load());

  const result = createMemo((): { game: Game | null; error: string | null } => {
    const l = loaded();
    if (l === null) return { game: null, error: null };
    try {
      return { game: l.cursor.at(step()), error: null };
    } catch (e) {
      return { game: null, error: e instanceof Error ? e.message : String(e) }; // CorruptJournalError: never play a damaged journal
    }
  });
  const scenes = createMemo((): Scene[] => {
    const own = loaded()?.session.game.scenes ?? [];
    return own.length > 0 ? own : Object.values(OUTPUT_SCENES);
  });
  const scene = () => scenes().find((s) => s.id === sceneId()) ?? scenes()[0];
  const view = createMemo(() => {
    const g = result().game;
    const sc = scene();
    return g === null || sc === undefined ? null : project(g, { role: "output", scene: sc.id }, defaultRegistry);
  });
  const total = () => loaded()?.events.length ?? 0;
  const current = () => loaded()?.events[step() - 1];
  /** Server time "now" at this step: the time of the last applied event (timers render as they were). */
  const nowAt = () => current()?.at ?? loaded()?.session.createdAt ?? 0;
  const go = (k: number) => setStep(Math.max(0, Math.min(total(), k)));
  const near = createMemo(() => {
    const evs = loaded()?.events ?? [];
    const from = Math.max(0, step() - 8);
    return evs.slice(from, from + 16);
  });
  const skipped = () => result().game?.skipped ?? [];

  return (
    <div class="s-replay">
      <div class="s-toolbar">
        <span class="s-label">Replay du journal</span>
        <Show when={loaded()}>{(l) => <span class="muted">« {l().session.game.title} » · session <span class="q-mono">{l().session.id}</span> · <span class="q-mono">{l().events.length}</span> événement(s)</span>}</Show>
        <span class="s-spacer" />
        <Button kind="secondary" onClick={() => void load()}>Recharger</Button>
      </div>
      <Show when={status()}>{(s) => <p class={s().ok ? "muted" : "s-bad"}>{s().text}</p>}</Show>
      <Show when={loaded()}>
        <div class="s-replay-grid">
          <section class="s-replay-main">
            <div class="s-toolbar s-transport">
              <Button kind="secondary" title="Début" disabled={step() === 0} onClick={() => go(0)}>|◀</Button>
              <Button kind="secondary" title="Événement précédent" disabled={step() === 0} onClick={() => go(step() - 1)}>◀</Button>
              <Button kind="secondary" title="Événement suivant" disabled={step() >= total()} onClick={() => go(step() + 1)}>▶</Button>
              <Button kind="secondary" title="Fin" disabled={step() >= total()} onClick={() => go(total())}>▶|</Button>
              <input class="s-scrub" type="range" min="0" max={total()} value={step()} aria-label="Position dans le journal" onInput={(e) => go(Number(e.currentTarget.value))} />
              <span class="q-mono s-step">{step()} / {total()}</span>
              <select value={scene()?.id ?? ""} aria-label="Scène" onChange={(e) => setSceneId(e.currentTarget.value)}>
                <For each={scenes()}>{(s) => <option value={s.id}>{s.name}</option>}</For>
              </select>
            </div>
            <Show when={current()} fallback={<p class="muted">Étape 0 : avant le premier événement.</p>}>
              {(e) => <p class="s-current"><span class="q-mono">#{e().seq} · {clock(e().at)}</span> <b>{e().action.type}</b> <span class="muted">par {actorLabel(e())}</span></p>}
            </Show>
            <Show when={result().error}>{(err) => <p class="s-bad">Rejeu impossible : {err()}</p>}</Show>
            <Show when={result().game !== null}>
                <>
                  <div class="s-mini s-replay-stage">
                    <Show when={scene()}>{(sc) => <SceneRenderer scene={sc()} theme={loaded()?.session.game.theme ?? DEFAULT_THEME} view={view()} serverNow={nowAt} fit />}</Show>
                  </div>
                  <p class="muted s-hint">Phase : <span class="q-mono">{view()?.phase ?? "—"}</span>{skipped().length > 0 ? ` · ${skipped().length} événement(s) sans effet (annulés ou devenus invalides)` : ""}</p>
                </>
            </Show>
          </section>
          <Panel title="Événements">
            <ol class="s-events">
              <For each={near()}>
                {(e) => (
                  <li data-on={String(e.seq === step())} data-future={String(e.seq > step())}>
                    <button type="button" onClick={() => go(e.seq)}>
                      <span class="q-mono">#{e.seq}</span>
                      <span class="s-ev-type">{e.action.type}</span>
                      <span class="s-ev-actor muted">{actorLabel(e)}</span>
                    </button>
                  </li>
                )}
              </For>
            </ol>
            <Show when={total() === 0}><p class="muted">Aucun événement dans le journal de la session en cours.</p></Show>
          </Panel>
        </div>
      </Show>
    </div>
  );
}
