import { For, Show, createSignal, type JSX } from "solid-js";
import { asBoard, asBuzzer, asHints, asLadder, asNumberAnswer, asPollBoard, asRevealImage, asTextAnswer, boardRows, formatNumber, nameOf } from "@quiz/renderer";
import type { Action, HostView } from "@quiz/schema";
import { ConfirmKey } from "@quiz/ui";

/**
 * The host's hands-on part of the question: who has the hand (✓ / ✗ in one tap), text answers to overrule,
 * poll-board slots — plus, when the control room lets the host drive, the in-question tools (hint, tile,
 * jokers, hand to a team, board cell). Every key sends one intent; the engine decides.
 */

type Act = (a: Action) => Promise<boolean>;
const JUDGEABLE = new Set(["open", "locked", "judging"]);

/** Buzzer / board: the player who has the hand, judged in one tap. */
function Hand(p: { readonly view: HostView; readonly act: Act; readonly m: { readonly hand: string | null; readonly winner: string | null; readonly queue: readonly string[] | null; readonly lockedOut: readonly string[] | null } }): JSX.Element {
  return (
    <div class="h-block">
      <Show
        when={p.m.winner}
        fallback={
          <Show when={p.m.hand} fallback={<p class="h-wait">{p.view.phase === "open" ? "En attente d'un buzz…" : p.view.phase === "presenting" ? "Buzzers fermés" : "Personne n'a la main"}</p>}>
            {(h) => (
              <>
                <span class="q-label">A la main</span>
                <p class="h-hand">{nameOf(p.view, h())}</p>
                <div class="h-verdict">
                  <button type="button" class="h-key h-key-ok" onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: true })}>✓ Bonne réponse</button>
                  <button type="button" class="h-key h-key-no" onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: false })}>✗ Faux</button>
                </div>
              </>
            )}
          </Show>
        }
      >
        {(w) => <p class="h-found">✓ {nameOf(p.view, w())} a trouvé</p>}
      </Show>
      <Show when={(p.m.queue ?? []).filter((id) => id !== p.m.hand).length > 0}>
        <p class="h-small">En file : {(p.m.queue ?? []).filter((id) => id !== p.m.hand).map((id) => nameOf(p.view, id)).join(" → ")}</p>
      </Show>
      <Show when={(p.m.lockedOut ?? []).length > 0}><p class="h-small">Bloqués : {(p.m.lockedOut ?? []).map((id) => nameOf(p.view, id)).join(", ")}</p></Show>
    </div>
  );
}

function PollBoard(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  const [team, setTeam] = createSignal("");
  const teamName = (id: string | null) => p.view.teamBoard.find((t) => t.teamId === id)?.name ?? "—";
  const open = () => JUDGEABLE.has(p.view.phase);
  return (
    <Show when={asPollBoard(p.view.mechanic)}>
      {(m) => (
        <div class="h-block">
          <div class="h-poll-head">
            <span>Main : <b>{teamName(m().controllingTeamId)}</b></span>
            <span class="h-strikes" aria-label={`${m().strikes} erreur(s) sur ${m().maxStrikes}`}>
              <For each={Array.from({ length: m().maxStrikes }, (_, i) => i < m().strikes)}>{(on) => <i data-on={String(on)}>✗</i>}</For>
            </span>
            <span class="q-mono">Banque {formatNumber(m().bank)}{m().multiplier !== 1 ? ` ×${m().multiplier}` : ""}</span>
          </div>
          <Show when={p.view.drive && (m().controllingTeamId === null || (m().stage === "steal" && m().stealingTeamId === null))}>
            <div class="h-row">
              <select class="h-select" value={team()} onChange={(e) => setTeam(e.currentTarget.value)} aria-label="Équipe">
                <option value="">Équipe…</option>
                <For each={p.view.teamBoard}>{(t) => <option value={t.teamId}>{t.name}</option>}</For>
              </select>
              <Show when={m().controllingTeamId === null} fallback={<button type="button" class="q-btn" disabled={team() === ""} onClick={() => void p.act({ type: "poll.steal", teamId: team() })}>Tentative de vol</button>}>
                <button type="button" class="q-btn" disabled={team() === ""} onClick={() => void p.act({ type: "poll.control", teamId: team() })}>Donner la main</button>
              </Show>
            </div>
          </Show>
          <Show when={m().stage === "steal"}><p class="h-alert">Vol : {teamName(m().stealingTeamId)}, une seule réponse</p></Show>
          <Show when={m().winnerTeamId !== null}><p class="h-found">Banque gagnée par {teamName(m().winnerTeamId)}</p></Show>
          <ol class="h-slots">
            <For each={m().slots}>
              {(s) => (
                <li data-found={String(s.found)} data-revealed={String(s.revealed)}>
                  <span class="h-slot-n">{s.index + 1}</span>
                  <span class="h-slot-label">{s.label ?? "?"}</span>
                  <span class="h-slot-v">{s.value ?? ""}</span>
                  <button type="button" class="h-slot-key" disabled={s.revealed || !open() || m().stage === "done" || s.optionId === null} title="La réponse donnée est sur le tableau" onClick={() => void p.act({ type: "answer.judge", optionId: s.optionId ?? "", correct: true })}>✓ Trouvée</button>
                </li>
              )}
            </For>
          </ol>
          <button type="button" class="h-key h-key-no" disabled={!open() || m().stage === "done" || (m().stage === "steal" && m().stealingTeamId === null)} onClick={() => void p.act({ type: "answer.judge", correct: false })}>✗ Mauvaise réponse</button>
        </div>
      )}
    </Show>
  );
}

function TextReview(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  return (
    <Show when={asTextAnswer(p.view.mechanic)?.review}>
      {(review) => (
        <div class="h-block">
          <span class="q-label">Réponses écrites · {review().filter((r) => r.accepted).length} juste(s)</span>
          <ul class="h-review">
            <For each={review()} fallback={<li class="h-wait">Aucune réponse pour l'instant.</li>}>
              {(r) => (
                <li data-accepted={String(r.accepted)}>
                  <span class="h-review-who">{nameOf(p.view, r.participantId)}</span>
                  <span class="h-review-said">{r.text}</span>
                  <Show when={r.overruled}><span class="h-tag">corrigé</span></Show>
                  <span class="h-review-keys">
                    <button type="button" class="h-toggle" data-on={String(r.accepted)} disabled={!JUDGEABLE.has(p.view.phase)} title="Compter juste" onClick={() => void p.act({ type: "answer.judge", participantId: r.participantId, correct: true })}>✓</button>
                    <button type="button" class="h-toggle h-toggle-no" data-on={String(!r.accepted)} disabled={!JUDGEABLE.has(p.view.phase)} title="Compter faux" onClick={() => void p.act({ type: "answer.judge", participantId: r.participantId, correct: false })}>✗</button>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </div>
      )}
    </Show>
  );
}

function Ranking(p: { readonly view: HostView }): JSX.Element {
  return (
    <Show when={asNumberAnswer(p.view.mechanic)?.ranking}>
      {(ranking) => (
        <div class="h-block">
          <span class="q-label">Les plus proches</span>
          <ol class="h-slots">
            <For each={ranking().slice(0, 5)}>
              {(r, i) => (
                <li data-found={String(r.win)}>
                  <span class="h-slot-n">{i() + 1}</span>
                  <span class="h-slot-label">{nameOf(p.view, r.participantId)}</span>
                  <span class="h-slot-v">{formatNumber(r.value)}</span>
                </li>
              )}
            </For>
          </ol>
        </div>
      )}
    </Show>
  );
}

/** Board between two cells: the host picks the next cell (drive mode). */
function BoardPick(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  return (
    <Show when={p.view.drive && p.view.phase === "idle" ? asBoard(p.view.mechanic) : null}>
      {(m) => (
        <div class="h-block">
          <span class="q-label">Choisir une case</span>
          <div class="q-board-pick h-board" style={{ "grid-template-columns": `repeat(${Math.max(1, m().categories.length)}, 1fr)` }}>
            <For each={m().categories}>{(c) => <span class="q-board-pick-cat">{c.name}</span>}</For>
            <For each={boardRows(m())}>
              {(row) => (
                <For each={row}>
                  {(cell) => (
                    <Show when={cell} fallback={<span />}>
                      {(c) => (
                        <button type="button" class="q-board-pick-cell" data-played={String(c().played)} disabled={c().played} onClick={() => void p.act({ type: "question.present", questionIndex: c().questionIndex })}>
                          {formatNumber(c().value)}
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}

export function Judge(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  const hand = () => asBuzzer(p.view.mechanic) ?? (asBoard(p.view.mechanic)?.cell !== null ? asBoard(p.view.mechanic) : null);
  return (
    <>
      <Show when={hand()}>{(m) => <Hand view={p.view} act={p.act} m={m()} />}</Show>
      <PollBoard view={p.view} act={p.act} />
      <TextReview view={p.view} act={p.act} />
      <Ranking view={p.view} />
      <BoardPick view={p.view} act={p.act} />
    </>
  );
}

/** In-question tools offered to a driving host, as plain keys. */
export function DriveTools(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  const live = () => p.view.phase !== "revealed";
  return (
    <>
      <Show when={asHints(p.view.mechanic)}>
        {(m) => <button type="button" class="h-key" disabled={!live() || m().hintCount >= m().total} onClick={() => void p.act({ type: "element.reveal", index: m().hintCount })}>Indice suivant <span class="q-mono">{m().hintCount}/{m().total}</span></button>}
      </Show>
      <Show when={asRevealImage(p.view.mechanic)}>
        {(m) => <button type="button" class="h-key" disabled={!live() || m().revealed.length >= m().cols * m().rows} onClick={() => void p.act({ type: "element.reveal", index: m().revealed.length })}>Dévoiler une case <span class="q-mono">{m().revealed.length}/{m().cols * m().rows}</span></button>}
      </Show>
      <Show when={asLadder(p.view.mechanic)}>
        {(m) => (
          <>
            <button type="button" class="h-key" disabled={m().jokers.fifty !== "available"} onClick={() => void p.act({ type: "joker.use", joker: "fifty" })}>50:50</button>
            <button type="button" class="h-key" disabled={m().jokers.audience !== "available"} onClick={() => void p.act({ type: "joker.use", joker: "audience" })}>Avis du public</button>
            <ConfirmKey class="h-key" label="Le candidat s'arrête" confirmLabel="Confirmer : il garde son gain ?" disabled={m().status !== "playing"} onConfirm={() => void p.act({ type: "ladder.stop" })} />
          </>
        )}
      </Show>
    </>
  );
}
