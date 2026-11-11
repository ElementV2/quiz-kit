import { For, Show, type JSX } from "solid-js";
import { MULTI_SCORING_FROM_FR, MULTI_SCORING_LABEL_FR, MultiScoring, multiScoringExplain, type Action, type ChoiceMechanicView, type MechanicView } from "@quiz/schema";

type Act = (a: Action, okText?: string) => Promise<boolean>;

/** The choice view of a several-answers QCM (with its way of counting), else null. */
export function multiChoiceOf(m: MechanicView | null | undefined): (ChoiceMechanicView & { multiScoring: NonNullable<ChoiceMechanicView["multiScoring"]> }) | null {
  return m?.mechanic === "choice" && m.multiScoring !== null ? { ...m, multiScoring: m.multiScoring } : null;
}

/** Host (read only): « Comptage : points partiels, erreurs déduites (réglage de la catégorie) ». */
export function multiScoringLine(m: MechanicView | null | undefined): string | null {
  const c = multiChoiceOf(m);
  return c === null ? null : `Comptage : ${MULTI_SCORING_LABEL_FR[c.multiScoring.mode]} (${MULTI_SCORING_FROM_FR[c.multiScoring.from]})`;
}

/**
 * Control room: how a several-answers QCM is counted — the four ways, each explained with an example on THIS question,
 * and where the current one comes from. Before the reveal it applies at the reveal; after it the points are rewritten
 * at once (`question.setMultiScoring`, journaled, undoable). Forced verdicts keep priority.
 */
export function MultiScoringPicker(p: { readonly questionId: string; readonly mechanic: MechanicView | null; readonly revealed: boolean; readonly readonly: boolean; readonly act: Act }): JSX.Element {
  const c = () => multiChoiceOf(p.mechanic);
  const counts = () => {
    const m = c();
    return { right: m?.correct?.length ?? 1, options: m?.options.length ?? 2 };
  };
  let box: HTMLFieldSetElement | undefined;
  // A radio the browser ticked stays ticked even when the action is refused: always show what the view says.
  const resync = () => {
    const now = c()?.multiScoring.mode;
    for (const r of box?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? []) r.checked = r.value === now;
  };
  const set = (mode: MultiScoring | null) =>
    void p.act({ type: "question.setMultiScoring", questionId: p.questionId, mode }, `Comptage : ${mode === null ? "réglage par défaut" : MULTI_SCORING_LABEL_FR[mode]}${p.revealed ? " — points recalculés" : ""}`).then((done) => {
      if (!done) resync();
    });
  return (
    <Show when={c()}>
      {(m) => (
        <fieldset ref={(el) => (box = el)} class="q-multi-scoring" aria-label="Comptage des réponses multiples">
          <legend class="q-label">Comptage des réponses multiples</legend>
          <p class="muted">
            Actuel : {MULTI_SCORING_LABEL_FR[m().multiScoring.mode]} — {MULTI_SCORING_FROM_FR[m().multiScoring.from]}
            {p.revealed ? " · changer recalcule les points de la question" : " · s'applique à la révélation"}
          </p>
          <For each={MultiScoring.options}>
            {(mode) => (
              <label class="q-multi-mode" data-on={String(m().multiScoring.mode === mode)}>
                <input type="radio" name={`multi-${p.questionId}`} value={mode} checked={m().multiScoring.mode === mode} disabled={p.readonly} onChange={() => set(mode)} />
                <span><strong>{MULTI_SCORING_LABEL_FR[mode]}</strong> : {multiScoringExplain(mode, counts().right, counts().options)}</span>
              </label>
            )}
          </For>
          <Show when={m().multiScoring.from === "control"}>
            <button type="button" class="q-btn q-btn-secondary" disabled={p.readonly} onClick={() => set(null)}>Revenir au réglage de la question / de la catégorie</button>
          </Show>
        </fieldset>
      )}
    </Show>
  );
}
