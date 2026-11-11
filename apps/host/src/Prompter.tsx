import { For, Show, createMemo, type JSX } from "solid-js";
import { asChoice, asLadder, asPin, optionLetter } from "@quiz/renderer";
import type { HostView } from "@quiz/schema";
import { ConfirmKey, formatAnswer } from "@quiz/ui";
import type { PresentOffer, Reading } from "./logic.ts";

/**
 * The prompter: the ONE question the host has to read (on air, or next / picked when nothing is on air),
 * its answer in accent, the host notes. Big type, readable at arm's length.
 */

const MODE_LABEL: Record<Reading["mode"], string> = {
  onair: "À l'antenne",
  next: "Pas encore à l'antenne — à lire",
  preview: "Aperçu — pas à l'antenne",
};
const MODE_TALLY: Record<Reading["mode"], string> = { onair: "air", next: "next", preview: "off" };

type Option = { readonly letter: string | null; readonly text: string; readonly right: boolean; readonly hidden: boolean; readonly share: string | null };

export function Prompter(p: {
  readonly view: HostView;
  readonly reading: Reading;
  readonly mediaUrl: (hash: string) => string;
  readonly offer: PresentOffer | null;
  readonly onPresent: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const r = () => p.reading;
  const onAir = () => r().mode === "onair";
  const text = () => (onAir() ? (p.view.question?.prompt.text ?? r().question.text) : r().question.text);
  const answer = createMemo(() => formatAnswer(r().question.answerSpec));
  const notes = () => (onAir() ? (p.view.notes ?? r().question.notes) : r().question.notes);
  /** On air, choices come from the view (shown order, letters, 50:50, public); otherwise from the spec. */
  const options = createMemo((): readonly Option[] => {
    const m = onAir() ? (asChoice(p.view.mechanic) ?? asLadder(p.view.mechanic)) : null;
    if (m !== null) {
      const right = (id: string) => (m.mechanic === "choice" ? m.correct?.includes(id) === true : m.correct === id);
      const hidden = (id: string) => m.mechanic === "ladder" && m.hidden.includes(id);
      const share = (id: string): string | null => {
        if (m.mechanic === "ladder") return m.audience === null ? null : `${m.audience[id] ?? 0} %`;
        return m.counts === null ? null : String(m.counts[id] ?? 0);
      };
      return m.options.map((o, i) => ({ letter: optionLetter(i), text: o.label, right: right(o.id), hidden: hidden(o.id), share: share(o.id) }));
    }
    const a = answer();
    return a.ordered ? [] : a.items.map((i) => ({ letter: null, text: i.text, right: i.right, hidden: false, share: i.value }));
  });
  // On air, a poll-board's slots are on the desk (to judge): no second copy here.
  const listed = () => (answer().ordered && !(onAir() && p.view.mechanic?.mechanic === "poll-board") ? answer().items : []);
  const image = () => {
    const m = onAir() ? p.view.question?.prompt.media : undefined;
    return m !== undefined && m.mime.startsWith("image/") ? m : null;
  };
  const pinZone = () => (onAir() ? (asPin(p.view.mechanic)?.correct ?? null) : null);
  const long = () => text().length > 140;
  const go = () => (p.offer !== null && p.offer.ok ? p.offer : null);
  const why = () => (p.offer !== null && !p.offer.ok ? p.offer.reason : null);

  return (
    <section class="h-prompter" data-mode={r().mode} tabindex="0" aria-label="Question à lire">
      <div class="h-strip">
        <span class="q-tally" data-on={MODE_TALLY[r().mode]}>{MODE_LABEL[r().mode]}</span>
        <span class="h-pos">{r().round.title} · <span class="q-mono">Q{r().question.index + 1}/{r().round.questions.length}</span></span>
        <Show when={r().question.points.summary}>
          {/* With live stakes on THIS question (the one they target), the staked worth. */}
          <span class="h-worth" title={r().question.points.why}>
            vaut {p.view.stakes?.worth !== undefined && p.view.stakes.worth !== "" && p.view.stakesTarget?.roundIndex === r().round.index && p.view.stakesTarget.questionIndex === r().question.index ? `${p.view.stakes.worth} (mise)` : r().question.points.summary}
          </span>
        </Show>
        <Show when={r().mode === "preview"}>
          <button type="button" class="q-btn q-btn-ghost h-back" onClick={() => p.onBack()}>Revenir au direct</button>
        </Show>
      </div>

      <p class="h-question" data-long={String(long())}>{text()}</p>

      <Show when={image()}>
        {(m) => (
          <div class="h-media">
            <img src={p.mediaUrl(m().hash)} alt="" />
            <Show when={pinZone()}>{(z) => <span class="h-pin" style={{ left: `${z().x * 100}%`, top: `${z().y * 100}%`, width: `${z().w * 100}%`, height: `${z().h * 100}%` }} />}</Show>
          </div>
        )}
      </Show>

      <Show when={options().length > 0}>
        <ul class="h-options">
          <For each={options()}>
            {(o) => (
              <li data-right={String(o.right)} data-hidden={String(o.hidden)}>
                <Show when={o.letter}>{(l) => <span class="h-letter">{l()}</span>}</Show>
                <span class="h-opt-text">{o.text}</span>
                <Show when={o.share}>{(s) => <span class="h-opt-share">{s()}</span>}</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="h-answer">
        <span class="q-label">Réponse</span>
        <p class="h-answer-main">{answer().headline}</p>
        <Show when={listed().length > 0}>
          <ol class="h-answer-list">
            <For each={listed()}>{(i) => <li><span>{i.text}</span><Show when={i.value}>{(v) => <b class="q-mono">{v()}</b>}</Show></li>}</For>
          </ol>
        </Show>
        <Show when={answer().note}>{(n) => <p class="h-answer-note">{n()}</p>}</Show>
      </div>

      <Show when={notes()}>
        {(n) => (
          <div class="h-notes">
            <span class="q-label">Notes</span>
            <p>{n()}</p>
          </div>
        )}
      </Show>

      <Show when={r().mode === "preview" ? why() : null}>{(w) => <p class="h-offer h-small">{w()}</p>}</Show>
      <Show when={r().mode === "preview" ? go() : null}>
        {(o) => (
          <div class="h-offer">
            <Show when={o().confirm} fallback={<button type="button" class="q-btn q-btn-big" onClick={() => p.onPresent()}>{o().label}</button>}>
              {(c) => <ConfirmKey class="q-btn-big" label={o().label} confirmLabel={c()} onConfirm={() => p.onPresent()} />}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
