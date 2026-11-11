import { For, Show, createSignal, type JSX } from "solid-js";
import { asBoard, asBuzzer, asChain, asHints, asLadder, asNumberAnswer, asPollBoard, asRevealImage, asTextAnswer, boardRows, chainCanBank, chainOfEarlierRound, chainOverText, chainSteps, duelScores, formatNumber, nameOf, pollSideAction, pollSides, sideName } from "@quiz/renderer";
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
  const teamName = (id: string | null) => sideName(p.view, id);
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
            <Show when={m().scoring === "per-answer"} fallback={<span class="q-mono">Banque {formatNumber(m().bank)}{m().multiplier !== 1 ? ` ×${m().multiplier}` : ""}</span>}>
              <span class="q-mono">{m().teamPoints.map((t) => `${teamName(t.teamId)} ${formatNumber(t.points)}`).join(" · ")}</span>
            </Show>
          </div>
          <Show when={p.view.drive && (m().stage !== "done" || m().slots.some((x) => !x.found)) && p.view.phase !== "revealed"}>
            <div class="h-row">
              <select class="h-select" value={team()} onChange={(e) => setTeam(e.currentTarget.value)} aria-label={p.view.teamBoard.length > 0 ? "Équipe" : "Joueur"}>
                <option value="">{p.view.teamBoard.length > 0 ? "Équipe…" : "Joueur…"}</option>
                <For each={pollSides(p.view)}>{(t) => <option value={t.id}>{t.name}</option>}</For>
              </select>
              <button type="button" class="q-btn" disabled={team() === "" || team() === m().controllingTeamId} onClick={() => void p.act(pollSideAction("poll.control", team()))}>{m().controllingTeamId === null ? "Donner la main" : "Passer la main"}</button>
              <Show when={m().stage === "steal" && m().stealingTeamId === null}>
                <button type="button" class="q-btn" disabled={team() === ""} onClick={() => void p.act(pollSideAction("poll.steal", team()))}>Tentative de vol</button>
              </Show>
            </div>
          </Show>
          <Show when={m().stage === "steal"}><p class="h-alert">Vol : {teamName(m().stealingTeamId)}, une seule réponse</p></Show>
          <Show when={m().scoring === "bank" && m().winnerTeamId !== null}><p class="h-found">Banque gagnée par {teamName(m().winnerTeamId)}</p></Show>
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

const CHAIN_ON_AIR = new Set(["presenting", "open", "locked", "judging"]);

/**
 * « La chaîne »: the player to read the question to, Juste / Faux in one tap (no need to open the answers), Banque
 * for the player; the chain and its bank; between rounds the vote (followed, never cast here) and the duel score.
 */
function Chain(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  return (
    <Show when={asChain(p.view.mechanic)}>
      {(m) => {
        const name = (id: string | null) => nameOf(p.view, id);
        const onAir = () => CHAIN_ON_AIR.has(p.view.phase);
        const earlier = () => chainOfEarlierRound(m(), p.view.round);
        const judgeable = () => onAir() && m().turn !== null && m().verdict === null && m().over === null && (m().duel?.winner ?? null) === null;
        const judge = (correct: boolean) => {
          const turn = m().turn;
          if (turn !== null) void p.act({ type: "answer.judge", participantId: turn, correct });
        };
        return (
          <div class="h-block h-chain" data-stage={m().stage}>
            <Show when={!earlier() && (onAir() || p.view.phase === "revealed")}>
              <span class="q-label">{m().stage === "duel" ? "Duel · question pour" : "Question pour"}</span>
              <p class="h-hand" data-testid="host-chain-turn">{m().turn === null ? "personne" : name(m().turn)}</p>
              <Show when={m().verdict}>{(v) => <p class={v() === "right" ? "h-found" : "h-wrong"}>{v() === "right" ? "✓ Juste" : "✗ Faux : la chaîne retombe à 0"}</p>}</Show>
              <div class="h-verdict">
                <button type="button" class="h-key h-key-ok" disabled={!judgeable()} onClick={() => judge(true)}>✓ Juste</button>
                <button type="button" class="h-key h-key-no" disabled={!judgeable()} onClick={() => judge(false)}>✗ Faux</button>
              </div>
              <Show when={m().stage === "chain"}>
                <button type="button" class="h-key" disabled={!chainCanBank(m(), p.view.phase)} onClick={() => { const t = m().turn; if (t !== null) void p.act({ type: "chain.bank", participantId: t }); }}>
                  Banque <span class="q-mono">{m().chainValue > 0 ? formatNumber(m().chainValue) : "chaîne à zéro"}</span>
                </button>
              </Show>
            </Show>
            <Show when={m().stage === "chain"}>
              <p class="h-chain-figs"><span>Banque <b class="q-mono">{formatNumber(m().bank)}</b><span class="h-small q-mono"> / {formatNumber(m().bankTarget)}</span></span><span>En jeu <b class="q-mono">{formatNumber(m().chainValue)}</b></span><span>Cagnotte <b class="q-mono">{formatNumber(m().totalBank)}</b></span></p>
              <ol class="h-chain-steps" aria-label="Montants de la chaîne">
                <For each={chainSteps(m()).toReversed()}>{(s) => <li data-state={s.state}>{formatNumber(s.amount)}</li>}</For>
              </ol>
              <Show when={!earlier() ? chainOverText(m().over) : null}>{(t) => <p class="h-alert">{t()}</p>}</Show>
              <Show when={m().over !== null && m().strongest !== null}>
                <p class="h-small">Maillon fort : <b>{name(m().strongest)}</b> · maillon faible : <b>{name(m().weakest)}</b></p>
              </Show>
            </Show>
            <Show when={m().stage === "duel"}>
              <ol class="h-slots">
                <For each={duelScores(m())}>{(s) => <li data-found={String(m().duel?.winner === s.participantId)}><span class="h-slot-label">{name(s.participantId)}</span><span class="h-slot-v">{s.right} / {s.asked}</span></li>}</For>
              </ol>
              <Show when={m().duel?.winner}>{(w) => <p class="h-found">{name(w())} remporte la cagnotte ({formatNumber(m().totalBank)})</p>}</Show>
            </Show>
            <Show when={m().vote}>
              {(v) => (
                <div class="h-chain-vote">
                  <span class="q-label">Vote d'élimination</span>
                  <Show when={v().status === "open"}><p class="h-small">Les joueurs votent sur leur tablette : <b class="q-mono">{v().cast} / {v().voters.length}</b></p></Show>
                  <Show when={v().status === "tie"}><p class="h-alert">Égalité : {v().tied.map((id) => name(id)).join(", ")}. {name(v().picker)} (maillon fort) choisit.</p></Show>
                  <Show when={v().eliminated}>{(id) => <p class="h-found">{name(id())} quitte la partie</p>}</Show>
                </div>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

export function Judge(p: { readonly view: HostView; readonly act: Act }): JSX.Element {
  const hand = () => asBuzzer(p.view.mechanic) ?? (asBoard(p.view.mechanic)?.cell !== null ? asBoard(p.view.mechanic) : null);
  return (
    <>
      <Show when={hand()}>{(m) => <Hand view={p.view} act={p.act} m={m()} />}</Show>
      <Chain view={p.view} act={p.act} />
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
      <Show when={asChain(p.view.mechanic)}>
        {(m) => {
          // Never once the round is over / decided, nor on the figures of the round before.
          const off = () => m().over !== null || (m().duel?.winner ?? null) !== null || chainOfEarlierRound(m(), p.view.round) || p.view.phase === "round.end" || p.view.phase === "game.end";
          return (
            <Show when={m().stage === "duel"} fallback={<ConfirmKey class="h-key" label="Fin de la manche (temps écoulé)" confirmLabel="Confirmer : la chaîne non mise en banque est perdue ?" disabled={off()} onConfirm={() => void p.act({ type: "chain.end" })} />}>
              <ConfirmKey class="h-key" label="Terminer le duel sans vainqueur" confirmLabel="Confirmer : la cagnotte n'est pas versée ?" disabled={off()} onConfirm={() => void p.act({ type: "chain.end" })} />
            </Show>
          );
        }}
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
