import { For, Match, Show, Switch, createEffect, createSignal, on, type JSX } from "solid-js";
import { chainCanBank, chainOfEarlierRound, formatNumber, nameOf, type ChainView } from "@quiz/renderer";
import type { Action, PlayerView } from "@quiz/schema";

/**
 * « La chaîne » on a tablet (ADR-0016). « À vous ! » and the Banque key ONLY for the player whose turn it is (the
 * others see whose turn it is); between rounds the elimination vote (another player of the round), the tie-break for the
 * strongest link; eliminated and duel states. Saved only after the server ack (doc 04): a vote reads « enregistré » once
 * the view carries it (`myVote`).
 */

type Ack = { readonly ok: true } | { readonly ok: false; readonly reason: string };
type Submit = (a: Action) => Promise<Ack>;
const ON_AIR = new Set(["presenting", "open", "locked", "judging"]);

export function ChainScreen(p: { readonly view: PlayerView; readonly m: ChainView; readonly submit: Submit }): JSX.Element {
  const m = () => p.m;
  const me = () => p.view.me?.participantId ?? null;
  const name = (id: string | null) => nameOf(p.view, id);
  const out = () => p.view.me?.status === "eliminated";
  // A new round not played yet: the vote and figures of the round before are history.
  const earlier = () => chainOfEarlierRound(m(), p.view.round);
  const [sending, setSending] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [banked, setBanked] = createSignal<number | null>(null);
  // A new question (or a new vote state) clears the last message.
  createEffect(on(() => `${p.view.question?.id ?? ""}:${m().vote?.status ?? ""}:${m().turn ?? ""}`, () => { setBanked(null); setError(null); }, { defer: true }));

  const send = async (key: string, a: Action, after?: () => void) => {
    if (sending() !== null) return;
    setSending(key);
    setError(null);
    navigator.vibrate?.(20);
    const ack = await p.submit(a);
    setSending(null);
    if (ack.ok) after?.();
    else setError(ack.reason);
  };
  const bank = () => {
    const id = me();
    const value = m().chainValue;
    if (id !== null) void send("bank", { type: "chain.bank", participantId: id }, () => setBanked(value));
  };
  // Never once the round is over or the duel decided (the question stays on screen until « Suivante »).
  const myTurn = () => me() !== null && m().turn === me() && ON_AIR.has(p.view.phase) && !out() && m().over === null && (m().duel?.winner ?? null) === null;

  return (
    <main class="p-question p-chain" data-stage={m().stage}>
      <div class="p-meta">
        <span>{m().stage === "duel" ? "Duel final" : (p.view.round?.title ?? "La chaîne")}</span>
        <Show when={m().stage === "chain" && !earlier()}><span>Banque <b class="q-mono">{formatNumber(m().bank)}</b></span></Show>
        <span>Cagnotte <b class="q-mono">{formatNumber(m().totalBank)}</b></span>
      </div>
      <Switch fallback={<Idle view={p.view} m={m()} earlier={earlier()} />}>
        {/* ── Vote d'élimination ── */}
        <Match when={earlier() ? null : m().vote}>
          {(v) => (
            <Switch>
              <Match when={v().status === "open" && me() !== null && v().voters.includes(me() ?? "")}>
                <section class="p-chain-vote" aria-labelledby="p-chain-vote-title">
                  <h1 class="p-prompt" id="p-chain-vote-title">Qui doit quitter la partie ?</h1>
                  <p class="muted p-hint">Votre vote est secret jusqu'à la clôture. Vous pouvez le changer tant que le vote est ouvert.</p>
                  <div class="p-options" role="group" aria-label="Voter contre">
                    <For each={v().voters.filter((id) => id !== me())}>
                      {(id) => (
                        <button type="button" class="p-option" aria-pressed={v().myVote === id} data-state={v().myVote === id ? "selected" : sending() === id ? "sending" : "idle"} disabled={sending() !== null} onClick={() => { const self = me(); if (self !== null) void send(id, { type: "chain.vote", participantId: self, against: id }); }}>
                          <span class="p-label">{name(id)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <footer class="p-feedback" role="status" data-tone={sending() !== null ? "busy" : error() !== null ? "no" : v().myVote !== null ? "ok" : "idle"}>
                    <Switch>
                      <Match when={sending() !== null}>Envoi…</Match>
                      <Match when={error()}>{error()}</Match>
                      <Match when={v().myVote}>{(id) => <>Vote enregistré ✓ contre {name(id())}<small>Modifiable jusqu'à la clôture</small></>}</Match>
                      <Match when={true}>Touchez un nom pour voter</Match>
                    </Switch>
                  </footer>
                </section>
              </Match>
              <Match when={v().status === "open"}>
                <div class="p-center"><p class="p-big">Vote d'élimination en cours</p><p class="muted">{v().cast} / {v().voters.length} vote(s)</p></div>
              </Match>
              <Match when={v().status === "tie" && v().picker === me() && me() !== null}>
                <section class="p-chain-vote" aria-labelledby="p-chain-tie-title">
                  <h1 class="p-prompt" id="p-chain-tie-title">Égalité : à vous de choisir</h1>
                  <p class="muted p-hint">Vous êtes le maillon fort de la manche : désignez qui quitte la partie.</p>
                  <div class="p-options" role="group" aria-label="Éliminer">
                    <For each={v().tied.filter((id) => id !== me())}>
                      {(id) => (
                        <button type="button" class="p-option" data-state={sending() === id ? "sending" : "idle"} disabled={sending() !== null} onClick={() => { const self = me(); if (self !== null) void send(id, { type: "chain.pick", participantId: self, eliminated: id }); }}>
                          <span class="p-label">{name(id)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <footer class="p-feedback" role="status" data-tone={sending() !== null ? "busy" : error() !== null ? "no" : "idle"}>
                    <Switch>
                      <Match when={sending() !== null}>Envoi…</Match>
                      <Match when={error()}>{error()}</Match>
                    </Switch>
                  </footer>
                </section>
              </Match>
              <Match when={v().status === "tie"}>
                <div class="p-center"><p class="p-big">Égalité</p><p>{v().tied.map((id) => name(id)).join(", ")} : {name(v().picker)}, maillon fort de la manche, choisit.</p></div>
              </Match>
              <Match when={v().eliminated}>
                {(id) => (
                  <div class="p-center">
                    <p class="p-big" data-testid="chain-out">{id() === me() ? "Vous quittez la partie" : `${name(id())} quitte la partie`}</p>
                    <Show when={v().tally}>{(t) => <ul class="p-chain-tally"><For each={t()}>{(r) => <li data-out={String(r.participantId === id())}><span>{name(r.participantId)}</span><b class="q-mono">{r.votes} voix</b></li>}</For></ul>}</Show>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </Match>
        {/* ── Éliminé ── */}
        <Match when={out()}>
          <div class="p-center"><p class="p-big">Vous avez quitté la partie</p><p class="muted">Merci d'avoir joué ! Suivez la suite à l'écran.</p></div>
        </Match>
        {/* ── Question à l'antenne ── */}
        <Match when={ON_AIR.has(p.view.phase) || p.view.phase === "revealed"}>
          <Show when={myTurn()} fallback={<p class="p-hand-other" data-testid="chain-other">{m().turn === null ? "Personne n'a la parole" : `C'est au tour de ${name(m().turn)}`}</p>}>
            <p class="p-hand-mine" data-testid="chain-mine">À vous ! Répondez à l'oral</p>
          </Show>
          <h1 class="p-prompt">{p.view.question?.prompt.text}</h1>
          <Show when={m().stage === "chain"}>
            <p class="p-ladder">{m().chainValue > 0 ? `Chaîne en cours : ${formatNumber(m().chainValue)}` : "Chaîne à zéro"}</p>
          </Show>
          <Show when={m().stage === "duel"}><Duel view={p.view} m={m()} /></Show>
          <Show when={myTurn() && m().stage === "chain"}>
            <button type="button" class="q-btn q-btn-big p-chain-bank" disabled={!chainCanBank(m(), p.view.phase) || sending() !== null} onClick={bank}>
              {m().chainValue > 0 ? `Banque ! (${formatNumber(m().chainValue)})` : "Banque (rien à mettre)"}
            </button>
          </Show>
          <footer class="p-feedback" role="status" data-tone={m().verdict === "right" && m().turn === me() ? "ok" : m().verdict === "wrong" && m().turn === me() ? "no" : sending() !== null ? "busy" : error() !== null ? "no" : banked() !== null ? "ok" : "idle"}>
            <Switch>
              <Match when={m().verdict !== null && m().turn === me()}>{m().verdict === "right" ? "✓ Juste !" : "✗ Faux…"}</Match>
              <Match when={m().verdict !== null}>{m().verdict === "right" ? `✓ ${name(m().turn)} : juste` : `✗ ${name(m().turn)} : faux`}</Match>
              <Match when={sending() !== null}>Envoi…</Match>
              <Match when={error()}>{error()}</Match>
              <Match when={banked()}>{(b) => <>Mis en banque ✓ {formatNumber(b())}</>}</Match>
              <Match when={p.view.phase === "revealed" && m().expected !== null}>Réponse : {m().expected}</Match>
            </Switch>
          </footer>
        </Match>
      </Switch>
    </main>
  );
}

function Duel(p: { readonly view: PlayerView; readonly m: ChainView }): JSX.Element {
  const me = () => p.view.me?.participantId ?? null;
  const name = (id: string) => (id === me() ? "Vous" : nameOf(p.view, id));
  return (
    <ul class="p-chain-duel" aria-label="Score du duel">
      <For each={p.m.order}>
        {(id) => {
          const s = () => p.m.stats.find((x) => x.participantId === id);
          return <li data-winner={String(p.m.duel?.winner === id)}><span>{name(id)}</span><b class="q-mono">{s()?.right ?? 0}</b><small class="muted">/ {(s()?.right ?? 0) + (s()?.wrong ?? 0)}</small></li>;
        }}
      </For>
    </ul>
  );
}

/** Between two turns, two rounds, or at the end: where the game stands. */
function Idle(p: { readonly view: PlayerView; readonly m: ChainView; readonly earlier: boolean }): JSX.Element {
  const me = () => p.view.me?.participantId ?? null;
  const winner = () => p.m.duel?.winner ?? null;
  return (
    <div class="p-center">
      <Show
        when={winner()}
        fallback={<p class="p-big">{p.view.phase === "game.end" ? "Partie terminée !" : p.view.phase === "round.end" ? "Fin de la manche" : "Prochaine question dans un instant…"}</p>}
      >
        {(w) => <p class="p-big" data-testid="chain-winner">{w() === me() ? `Vous remportez la cagnotte : ${formatNumber(p.m.totalBank)} !` : `${nameOf(p.view, w())} remporte la cagnotte (${formatNumber(p.m.totalBank)})`}</p>}
      </Show>
      <Show when={p.m.stage === "duel" && !p.earlier}><Duel view={p.view} m={p.m} /></Show>
      <Show when={p.m.stage === "chain" && !p.earlier && p.m.over !== null && p.m.strongest !== null}>
        <p class="muted">Maillon fort : {nameOf(p.view, p.m.strongest)} · maillon faible : {nameOf(p.view, p.m.weakest)}</p>
      </Show>
    </div>
  );
}
