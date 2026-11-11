import { For, Show, type JSX } from "solid-js";
import type { HostView } from "@quiz/schema";
import { MECHANIC_LABEL, sameTarget, type Target } from "@quiz/ui";

/** Run-down drawer: every round and question; a tap previews it on the prompter (read only). */
export function RundownDrawer(p: {
  readonly view: HostView;
  readonly onAir: Target | null;
  readonly next: Target | null;
  readonly selected: Target | null;
  readonly onPick: (t: Target) => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div class="h-drawer-wrap" onClick={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <aside class="h-drawer" aria-label="Déroulé">
        <header class="h-drawer-head">
          <h2>Déroulé</h2>
          <span class="h-small">{p.view.drive ? "Touchez une question pour la lire, puis la présenter." : "Touchez une question pour la lire (lecture seule)."}</span>
          <button type="button" class="q-btn q-btn-secondary" onClick={() => p.onClose()}>Fermer</button>
        </header>
        <div class="h-drawer-body">
          <For each={p.view.rundown}>
            {(r) => (
              <section class="h-round" data-current={String(p.view.round?.index === r.index)}>
                <h3><span>{r.title}</span><span class="h-round-kind">{MECHANIC_LABEL[r.mechanic] ?? r.mechanic} · <span class="q-mono">{r.questions.length}</span></span></h3>
                <ol>
                  <For each={r.questions}>
                    {(q) => {
                      const t = { roundIndex: r.index, questionIndex: q.index };
                      const state = () => (sameTarget(t, p.onAir) ? "air" : sameTarget(t, p.next) ? "next" : q.played ? "played" : "todo");
                      return (
                        <li>
                          <button type="button" class="h-rq" data-state={state()} data-selected={String(sameTarget(t, p.selected))} onClick={() => p.onPick(t)}>
                            <span class="h-rq-n">{q.index + 1}</span>
                            <span class="h-rq-t">{q.text}</span>
                            <Show when={state() === "air"}><span class="q-tally" data-on="air">Antenne</span></Show>
                            <Show when={state() === "next"}><span class="q-tally" data-on="next">Suivante</span></Show>
                            <Show when={state() === "played"}><span class="h-rq-done" title="Déjà jouée">✓</span></Show>
                          </button>
                        </li>
                      );
                    }}
                  </For>
                </ol>
              </section>
            )}
          </For>
        </div>
      </aside>
    </div>
  );
}
