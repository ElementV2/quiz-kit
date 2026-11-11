import { confirmDialog } from "./Dialog.tsx";
import { For, Show, createSignal, type JSX } from "solid-js";
import { asBuzzer, asLadder, asPollBoard, nameOf, pollSideAction, pollSides, sideName } from "@quiz/renderer";
import type { Action, ControlView, HostView } from "@quiz/schema";
import { Button } from "./components.tsx";
import { Phase3Panel } from "./AnswerPanels.tsx";
import { CrowdVotePanel } from "./CrowdVotePanel.tsx";

/**
 * Mechanic-specific controls (doc 08 « actions contextuelles »), shared by the control room and the host.
 * `host` mode only offers what the host role may do (`answer.judge`); the server checks it anyway.
 */
export function MechanicPanel(p: {
  readonly view: ControlView | HostView;
  readonly mode: "control" | "host";
  readonly act: (a: Action, okText?: string) => Promise<boolean>;
  /** Media URL (preloaded blob); default `/media/<hash>`. */
  readonly mediaUrl?: (hash: string) => string;
}): JSX.Element {
  const control = () => p.mode === "control";
  const teams = () => (p.view.role === "control" ? p.view.teams : []);
  const teamName = (id: string | null) => (id !== null && id.startsWith("p_") ? sideName(p.view, id) : (p.view.teamBoard.find((t) => t.teamId === id)?.name ?? teams().find((t) => t.id === id)?.name ?? "—"));
  const sides = () => pollSides(p.view);
  const [team, setTeam] = createSignal<string>("");
  const open = () => p.view.phase === "open" || p.view.phase === "locked";

  return (
    <div class="q-mech">
      {/* ── Sondage à slots ── */}
      <Show when={asPollBoard(p.view.mechanic)}>
        {(m) => (
          <div class="q-mech-poll">
            <div class="q-mech-row">
              <span>Main : <b>{teamName(m().controllingTeamId)}</b></span>
              <span class="q-mech-strikes">{"✗".repeat(m().strikes)}<span class="muted">{"✗".repeat(Math.max(0, m().maxStrikes - m().strikes))}</span></span>
              <Show when={m().scoring === "per-answer"} fallback={<span>Banque <b>{m().bank}</b>{m().multiplier !== 1 ? ` ×${m().multiplier}` : ""}</span>}>
                <span>{m().teamPoints.length === 0 ? "Chacun marque ce qu'il trouve" : m().teamPoints.map((t) => `${teamName(t.teamId)} ${t.points}`).join(" · ")}{m().multiplier !== 1 ? ` (multiplicateur ×${m().multiplier} compris)` : ""}</span>
              </Show>
            </div>
            <Show when={control() && (m().stage !== "done" || m().slots.some((x) => !x.found)) && p.view.phase !== "revealed"}>
              <div class="q-mech-row">
                <select value={team()} onChange={(e) => setTeam(e.currentTarget.value)}>
                  <option value="">{teams().length > 0 ? "— équipe —" : "— joueur —"}</option>
                  <For each={sides()}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                </select>
                <Button kind={m().controllingTeamId === null ? "primary" : "secondary"} disabled={team() === "" || team() === m().controllingTeamId} onClick={() => void p.act(pollSideAction("poll.control", team()))}>{m().controllingTeamId === null ? "Donner la main" : "Passer la main"}</Button>
                <Show when={m().stage === "steal" && m().stealingTeamId === null}>
                  <Button disabled={team() === ""} onClick={() => void p.act(pollSideAction("poll.steal", team()))}>Tentative de vol</Button>
                </Show>
              </div>
            </Show>
            <Show when={m().stage === "steal"}><p class="q-mech-alert">Vol : {teamName(m().stealingTeamId)} — une seule réponse</p></Show>
            <Show when={m().scoring === "bank" && m().winnerTeamId !== null}><p class="q-mech-ok">Banque gagnée par {teamName(m().winnerTeamId)}</p></Show>
            <ol class="q-mech-slots">
              <For each={m().slots}>
                {(s) => (
                  <li data-found={String(s.found)} data-revealed={String(s.revealed)}>
                    <span class="q-mech-slot-label">{s.label ?? "?"}</span>
                    <span class="q-mech-num">{s.value ?? ""}</span>
                    <Button kind="secondary" disabled={s.revealed || !open() || m().stage === "done" || s.optionId === null} title="La réponse donnée est sur le tableau" onClick={() => void p.act({ type: "answer.judge", optionId: s.optionId ?? "", correct: true })}>✓ Trouvée</Button>
                    <Show when={control()}>
                      <Button kind="ghost" disabled={s.revealed} title="Retourner sans attribuer de points" onClick={() => void p.act({ type: "element.reveal", index: s.index })}>Révéler</Button>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
            <Button kind="danger" disabled={!open() || m().stage === "done" || (m().stage === "steal" && m().stealingTeamId === null)} onClick={() => void p.act({ type: "answer.judge", correct: false })}>✗ Mauvaise réponse</Button>
          </div>
        )}
      </Show>

      {/* ── Buzzer ── */}
      <Show when={asBuzzer(p.view.mechanic)}>
        {(m) => (
          <div class="q-mech-buzzer">
            <Show when={m().expected ?? m().options?.find((o) => o.id === m().correct)?.label}>{(e) => <p class="q-mech-ok">Réponse attendue : {e()}</p>}</Show>
            <Show when={m().winner} fallback={
              <Show when={m().hand} fallback={<p class="muted">{p.view.phase === "open" ? "En attente d'un buzz…" : "Ouvrir les réponses pour activer les buzzers."}</p>}>
                {(h) => (
                  <>
                    <p class="q-mech-hand">Main : <b>{nameOf(p.view, h())}</b></p>
                    <div class="q-mech-row">
                      <Button onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: true })}>✓ Bonne réponse</Button>
                      <Button kind="danger" onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: false })}>✗ Faux</Button>
                    </div>
                  </>
                )}
              </Show>
            }>
              {(w) => <p class="q-mech-ok">✓ {nameOf(p.view, w())} a trouvé</p>}
            </Show>
            <Show when={(m().queue ?? []).length > 0}><p class="muted">File : {(m().queue ?? []).map((id) => nameOf(p.view, id)).join(" → ")}</p></Show>
            <Show when={(m().lockedOut ?? []).length > 0}><p class="muted">Bloqués : {(m().lockedOut ?? []).map((id) => nameOf(p.view, id)).join(", ")}</p></Show>
          </div>
        )}
      </Show>

      {/* ── Phase 3 : réponse libre, estimation, ordre, paires, pin, répartition, plateau, indices, image ── */}
      <Phase3Panel view={p.view} mode={p.mode} act={p.act} mediaUrl={p.mediaUrl ?? ((h) => `/media/${h}`)} />

      {/* ── Vote du chat ── */}
      <CrowdVotePanel mechanic={p.view.mechanic} teams={p.mode === "control" && p.view.role === "control" ? p.view.teams : undefined} revealed={p.view.phase === "revealed"} act={p.mode === "control" ? p.act : undefined} />

      {/* ── Paliers ── */}
      <Show when={asLadder(p.view.mechanic)}>
        {(m) => (
          <div class="q-mech-ladder">
            <p>Candidat : <b>{m().candidate === null ? "première réponse" : nameOf(p.view, m().candidate)}</b> · palier {m().level + 1}/{m().steps.length} · en jeu <b>{(m().atStake ?? 0).toLocaleString("fr-FR")}</b> · assuré {m().secured.toLocaleString("fr-FR")} · gain {m().gain.toLocaleString("fr-FR")}</p>
            <Show when={m().correct !== null}><p class="q-mech-ok">Bonne réponse : {m().options.find((o) => o.id === m().correct)?.label}</p></Show>
            <Show when={control()}>
              <div class="q-mech-row">
                <Button kind="secondary" disabled={m().jokers.fifty !== "available"} onClick={() => void p.act({ type: "joker.use", joker: "fifty" })}>50:50</Button>
                <Button kind="secondary" disabled={m().jokers.audience !== "available"} onClick={() => void p.act({ type: "joker.use", joker: "audience" })}>Sondage du public</Button>
                <Button kind="ghost" disabled={m().status !== "playing"} onClick={() => void confirmDialog({ title: "Le candidat s'arrête ?", message: "Il garde le gain atteint ; la partie des paliers se termine.", confirm: "Il s'arrête", danger: true }).then((ok) => ok && p.act({ type: "ladder.stop" }, "Le candidat s'arrête"))}>Je m'arrête</Button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
