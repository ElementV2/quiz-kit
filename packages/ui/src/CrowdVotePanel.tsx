import { For, Show, type JSX } from "solid-js";
import { asCrowdVote, formatNumber, optionLetter } from "@quiz/renderer";
import type { Action, MechanicView } from "@quiz/schema";

/**
 * Chat vote (`crowd-vote`) for the control room and the host: votes per option as bars, voters, and the
 * majority once revealed. The votes come from the chat ingest, never from this panel; the control room picks the team
 * that scores when the majority is right (`teams` + `act` given: control room only).
 */
export function CrowdVotePanel(p: {
  readonly mechanic: MechanicView | null;
  readonly teams?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly revealed?: boolean | undefined;
  readonly act?: ((a: Action, okText?: string) => Promise<boolean>) | undefined;
}): JSX.Element {
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
            <Show when={m().points > 0}>
              <Show
                when={p.teams !== undefined && p.act !== undefined && p.revealed !== true}
                fallback={<p class="muted">{m().teamId === null ? "Aucune équipe ne reçoit les points du chat." : `${p.teams?.find((t) => t.id === m().teamId)?.name ?? "Une équipe"} reçoit ${m().points} pts si la majorité a raison.`}</p>}
              >
                <label class="q-crowd-team">Si la majorité a raison, {m().points} pts pour
                  <select value={m().teamId ?? ""} onChange={(e) => { const v = e.currentTarget.value; void p.act?.({ type: "crowd.setTeam", teamId: v === "" ? null : v }, v === "" ? "aucune équipe" : "équipe du chat choisie"); }}>
                    <option value="">aucune équipe</option>
                    <For each={p.teams ?? []}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                  </select>
                </label>
                <Show when={(p.teams ?? []).length === 0}><p class="muted">Créer une équipe (onglet Joueurs, ex. « Le chat ») pour lui donner les points.</p></Show>
              </Show>
            </Show>
            <Show when={m().majority}>
              {(maj) => <p class="q-mech-ok">Majorité : {m().options.filter((o) => maj().includes(o.id)).map((o) => o.label).join(" / ") || "aucun vote"}</p>}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
