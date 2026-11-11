import { For, Show, type JSX } from "solid-js";
import { asCrowdVote, formatNumber, optionLetter } from "@quiz/renderer";
import type { MechanicView } from "@quiz/schema";

/**
 * Chat vote (`crowd-vote`) for the control room and the host: votes per option as bars, voters, and the
 * majority once revealed. Read only: the votes come from the chat ingest, never from this panel.
 */
export function CrowdVotePanel(p: { readonly mechanic: MechanicView | null }): JSX.Element {
  return (
    <Show when={asCrowdVote(p.mechanic)}>
      {(m) => {
        const total = () => Object.values(m().counts ?? {}).reduce((a, b) => a + b, 0);
        const share = (id: string) => (total() === 0 ? 0 : Math.round(((m().counts?.[id] ?? 0) / total()) * 100));
        const majority = (id: string) => m().majority?.includes(id) === true;
        return (
          <div class="q-crowd">
            <p class="q-crowd-head">
              <span class="q-label">Vote du chat</span>
              <span class="q-mono">{m().voters === null ? "—" : formatNumber(m().voters ?? 0)} votant(s)</span>
              <Show when={m().streamDelayMs > 0}><span class="muted q-mono" title="Votes encore acceptés après la fermeture (retard du stream)">+{Math.round(m().streamDelayMs / 1000)} s de retard</span></Show>
            </p>
            <ul class="q-crowd-bars">
              <For each={m().options}>
                {(o, i) => (
                  <li data-majority={String(majority(o.id))} data-correct={String(m().correct === o.id)}>
                    <span class="q-crowd-letter">{optionLetter(i())}</span>
                    <span class="q-crowd-label">{o.label}</span>
                    <span class="q-crowd-bar"><i style={{ width: `${share(o.id)}%` }} /></span>
                    <span class="q-crowd-n q-mono">{m().counts === null ? "—" : `${share(o.id)} %`}</span>
                  </li>
                )}
              </For>
            </ul>
            <Show when={m().majority}>
              {(maj) => <p class="q-mech-ok">Majorité : {m().options.filter((o) => maj().includes(o.id)).map((o) => o.label).join(" / ") || "aucun vote"}</p>}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
