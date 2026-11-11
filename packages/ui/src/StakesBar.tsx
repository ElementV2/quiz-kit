import { For, Show, createSignal, type JSX } from "solid-js";
import type { Action, BaseView } from "@quiz/schema";

/**
 * Live stakes (« cette question vaut 500 points », « ×5 ») in one tap: control room and host when driving.
 * Applies to the question on air, or between questions to the next one (engine `question.setStakes`).
 */

const MULTIPLIERS = [2, 3, 5, 10] as const;

/** « ×5 · 500 pts » — the badge text (null = the round's own rule). */
export function stakesLabel(s: BaseView["stakes"]): string | null {
  if (s === null) return null;
  const parts = [s.points === null ? null : `${s.points} pts`, s.multiplier === null ? null : `×${String(s.multiplier).replace(".", ",")}`].filter((x) => x !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function StakesBar(p: { view: Pick<BaseView, "phase" | "stakes" | "round" | "stakesTarget">; act: (a: Action, label?: string) => unknown; class?: string }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [points, setPoints] = createSignal("");
  const cur = () => p.view.stakes;
  const target = (): BaseView["stakesTarget"] => p.view.stakesTarget;
  const usable = () => target() !== null;
  const pointsOk = () => target()?.points === true;
  const which = () => (p.view.phase === "idle" ? "la prochaine question" : "cette question");
  const set = (pts: number | null, mult: number | null) => {
    const t = target();
    if (t === null) return;
    void p.act({ type: "question.setStakes", roundIndex: t.roundIndex, questionIndex: t.questionIndex, points: pts, multiplier: mult }, pts === null && mult === null ? "Mise normale" : `Mise : ${stakesLabel({ points: pts, multiplier: mult }) ?? ""}`);
  };
  const submitPoints = (e: SubmitEvent) => {
    e.preventDefault();
    const n = Number.parseInt(points(), 10);
    if (!Number.isInteger(n) || n < 0) return;
    set(n, cur()?.multiplier ?? null);
    setEditing(false);
  };
  return (
    <div class={`q-stakes ${p.class ?? ""}`} role="group" aria-label={`Mise de ${which()}`} title={usable() ? undefined : "Mise possible sur la question à l'antenne ou la suivante (plateau : choisir la case d'abord ; pas de mise sur les paliers)"}>
      <span class="q-stakes-label">Mise</span>
      <button type="button" class="q-stakes-key" data-on={String(cur() === null)} disabled={!usable()} onClick={() => set(null, null)} title={`Barème normal de la manche pour ${which()}`}>Normale</button>
      <For each={MULTIPLIERS}>
        {(m) => <button type="button" class="q-stakes-key q-mono" data-on={String(cur()?.multiplier === m)} disabled={!usable()} onClick={() => set(cur()?.points ?? null, cur()?.multiplier === m ? null : m)} title={`${which()} compte ×${m}`}>×{m}</button>}
      </For>
      <Show
        when={editing()}
        fallback={<button type="button" class="q-stakes-key" data-on={String(cur()?.points != null)} disabled={!usable() || !pointsOk()} onClick={() => { setPoints(String(cur()?.points ?? "")); setEditing(true); }} title={`Points fixes pour ${which()}`}>{cur()?.points != null ? `${cur()?.points} pts` : "Points…"}</button>}
      >
        <form class="q-stakes-form" onSubmit={submitPoints}>
          <input class="q-mono" type="number" min="0" step="10" inputmode="numeric" aria-label="Points de la question" value={points()} onInput={(e) => setPoints(e.currentTarget.value)} autofocus />
          <button type="submit" class="q-stakes-key" data-on="true">OK</button>
          <button type="button" class="q-stakes-key" onClick={() => { setEditing(false); if (cur()?.points != null) set(null, cur()?.multiplier ?? null); }}>Retirer</button>
        </form>
      </Show>
    </div>
  );
}
