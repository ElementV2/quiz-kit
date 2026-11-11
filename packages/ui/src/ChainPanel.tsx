import { For, Show, createSignal, type JSX } from "solid-js";
import { asChain, chainCanBank, chainOfEarlierRound, chainOverText, chainSteps, duelScores, formatNumber, nameOf, type ChainView } from "@quiz/renderer";
import type { Action, ControlView, HostView } from "@quiz/schema";
import { Button } from "./components.tsx";
import { confirmDialog } from "./Dialog.tsx";

/**
 * « La chaîne » (ADR-0016) for the control room: whose turn, the chain and its bank, Juste / Faux / Banque / Fin de la
 * manche, then the elimination vote (open, follow, close, tie-break for the strongest link) and the final duel.
 * Keys keep their place (greyed when they do not apply). Every key is one intent; the engine decides.
 * `host` mode (read-only control post) only shows the figures and the keys the host may use (judge, bank).
 */

type Act = (a: Action, okText?: string) => Promise<boolean>;
const ON_AIR = new Set(["presenting", "open", "locked", "judging"]);

export function ChainPanel(p: { readonly view: ControlView | HostView; readonly mode: "control" | "host"; readonly act: Act }): JSX.Element {
  return <Show when={asChain(p.view.mechanic)}>{(m) => <ChainBody view={p.view} mode={p.mode} act={p.act} m={m()} />}</Show>;
}

function ChainBody(p: { readonly view: ControlView | HostView; readonly mode: "control" | "host"; readonly act: Act; readonly m: ChainView }): JSX.Element {
  const m = () => p.m;
  const name = (id: string | null) => nameOf(p.view, id);
  const control = () => p.mode === "control";
  const onAir = () => ON_AIR.has(p.view.phase);
  const earlier = () => chainOfEarlierRound(m(), p.view.round);
  const judgeable = () => onAir() && m().turn !== null && m().verdict === null && m().over === null && (m().duel?.winner ?? null) === null;
  // « Fin de la manche » / « Terminer le duel sans vainqueur »: exactly when the engine accepts it (`canEnd`).
  const endable = () => m().canEnd && !earlier();
  const judge = (correct: boolean) => {
    const turn = m().turn;
    // Only a right answer is good news (green line); a wrong one is shown in red on the panel itself.
    if (turn !== null) void p.act({ type: "answer.judge", participantId: turn, correct }, correct ? `Juste : ${m().stage === "duel" ? "un point au duel" : "la chaîne monte"} (${name(turn)})` : undefined);
  };
  const bank = () => {
    const turn = m().turn;
    if (turn !== null) void p.act({ type: "chain.bank", participantId: turn }, `${formatNumber(m().chainValue)} mis en banque pour ${name(turn)}`);
  };
  const end = async () => {
    const ok = await confirmDialog({ title: "Terminer la manche de chaîne ?", message: m().chainValue > 0 ? `Le temps est écoulé : la chaîne en cours (${formatNumber(m().chainValue)}) n'est pas mise en banque, elle est perdue.` : "Le temps est écoulé : la manche s'arrête ici, la banque est gardée.", confirm: "Fin de la manche", danger: true });
    if (ok) await p.act({ type: "chain.end" }, "Manche de chaîne terminée : « Suivante » pour passer au vote");
  };
  const endDuel = async () => {
    const ok = await confirmDialog({ title: "Terminer le duel sans vainqueur ?", message: `Personne ne gagne le duel : la cagnotte (${formatNumber(m().totalBank)}) n'est pas versée. Pour départager plutôt, ajouter des questions au duel (studio, « Envoyer au direct »).`, confirm: "Terminer le duel sans vainqueur", danger: true });
    if (ok) await p.act({ type: "chain.end" }, "Duel terminé sans vainqueur : la cagnotte n'est pas versée");
  };

  return (
    <div class="q-chain" data-stage={m().stage}>
      <div class="q-chain-head">
        <span class="q-label">{m().stage === "duel" ? "Duel final" : "Manche de chaîne"}</span>
        <Show when={m().stage === "chain"}>
          <span class="q-chain-fig">Banque <b class="q-mono" data-testid="chain-bank">{formatNumber(m().bank)}</b><span class="muted q-mono"> / {formatNumber(m().bankTarget)}</span></span>
        </Show>
        <span class="q-chain-fig" title="Toutes les banques de la partie : le vainqueur du duel final les remporte">Cagnotte <b class="q-mono">{formatNumber(m().totalBank)}</b></span>
      </div>

      <Show when={earlier()}>
        <p class="muted">Résultat de la manche précédente. La nouvelle manche commence à sa première question.</p>
      </Show>

      {/* ── À l'antenne : le tour, la réponse attendue, les touches ── */}
      <Show when={!earlier() && (onAir() || p.view.phase === "revealed")}>
        <div class="q-chain-turn">
          <span class="q-label">Au tour de</span>
          <b class="q-chain-who" data-testid="chain-turn">{m().turn === null ? "personne" : name(m().turn)}</b>
          <Show when={m().verdict}>{(v) => <span class="q-chain-verdict" data-verdict={v()}>{v() === "right" ? "✓ Juste" : "✗ Faux"}</span>}</Show>
        </div>
        <Show when={m().expected}>{(e) => <p class="q-mech-ok">Réponse attendue : {e()}</p>}</Show>
      </Show>
      <Show when={!earlier()}>
        <div class="q-chain-keys">
          <Button disabled={!judgeable()} title={m().stage === "duel" ? "Un point au duel" : "La chaîne monte d'un cran"} onClick={() => judge(true)}>✓ Juste</Button>
          <Button kind="danger" disabled={!judgeable()} title={m().stage === "duel" ? "Pas de point au duel" : "La chaîne non mise en banque est perdue, elle retombe à 0"} onClick={() => judge(false)}>✗ Faux</Button>
          <Button kind="secondary" disabled={!chainCanBank(m(), p.view.phase)} title={m().stage === "duel" ? "Pas de banque pendant le duel" : "Avant la réponse : la chaîne passe en banque et repart de 0 (le joueur peut aussi le faire depuis sa tablette)"} onClick={bank}>
            Banque{m().chainValue > 0 && m().stage === "chain" ? ` ${formatNumber(m().chainValue)}` : ""}
          </Button>
          <Show when={control()}>
            <Show when={m().stage === "duel"} fallback={<Button kind="ghost" disabled={!endable()} title="Le temps de la manche est écoulé : elle s'arrête (ce qui n'est pas en banque est perdu)" onClick={() => void end()}>Fin de la manche</Button>}>
              <Button kind="ghost" disabled={!endable()} title="Si les questions du duel ne suffisent pas : le duel s'arrête sans vainqueur, la cagnotte n'est pas versée" onClick={() => void endDuel()}>Terminer le duel sans vainqueur</Button>
            </Show>
          </Show>
        </div>
      </Show>

      {/* ── La chaîne ── */}
      <Show when={m().stage === "chain" && m().steps.length > 0}>
        <ol class="q-chain-steps" aria-label="Montants de la chaîne">
          <For each={chainSteps(m()).toReversed()}>
            {(s) => <li data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>{formatNumber(s.amount)}</li>}
          </For>
        </ol>
        <p class="muted q-chain-at">{m().chainValue > 0 ? `En jeu : ${formatNumber(m().chainValue)} (perdu sur une erreur s'il n'est pas mis en banque)` : "Chaîne à zéro"}</p>
      </Show>
      <Show when={!earlier() ? chainOverText(m().over) : null}>{(t) => <p class="q-mech-alert">{t()}</p>}</Show>

      {/* ── Duel ── */}
      <Show when={m().stage === "duel"}>
        <ul class="q-chain-duel">
          <For each={duelScores(m())}>
            {(s) => (
              <li data-winner={String(m().duel?.winner === s.participantId)}>
                <span class="q-chain-name">{name(s.participantId)}</span>
                <b class="q-mono">{s.right}</b>
                <span class="muted q-mono">bonne(s) sur {s.asked} · {m().duel?.questionsEach ?? 0} chacun</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={m().duel?.suddenDeath === true && m().duel?.winner === null}><p class="q-mech-alert">Mort subite : une question chacun jusqu'à ce que l'un se trompe et pas l'autre</p></Show>
        <Show when={m().duel?.winner}>{(w) => <p class="q-mech-ok" data-testid="chain-winner">{name(w())} gagne le duel et remporte la cagnotte ({formatNumber(m().totalBank)})</p>}</Show>
      </Show>

      {/* ── Chiffres de la manche ── */}
      <Show when={m().stage === "chain" && m().stats.length > 0}>
        <table class="q-chain-stats">
          <thead><tr><th scope="col">Joueur</th><th scope="col">Justes</th><th scope="col">Fausses</th><th scope="col">En banque</th><th scope="col"><span class="q-sr">Rôle</span></th></tr></thead>
          <tbody>
            <For each={m().stats}>
              {(s) => (
                <tr data-turn={String(s.participantId === m().turn && onAir())}>
                  <th scope="row">{name(s.participantId)}</th>
                  <td class="q-mono">{s.right}</td>
                  <td class="q-mono">{s.wrong}</td>
                  <td class="q-mono">{formatNumber(s.banked)}</td>
                  <td>
                    <Show when={s.participantId === m().strongest}><span class="q-chain-tag" data-tone="ok">Maillon fort</span></Show>
                    <Show when={s.participantId === m().weakest && m().weakest !== m().strongest}><span class="q-chain-tag" data-tone="no">Maillon faible</span></Show>
                    <Show when={m().eliminations.some((e) => e.participantId === s.participantId)}><span class="q-chain-tag">Éliminé</span></Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={m().stage === "chain" && !onAir()}>
        <ChainVote view={p.view} mode={p.mode} act={p.act} m={m()} />
      </Show>
    </div>
  );
}

/** Elimination vote between two rounds (control): open, follow, vote for a player without tablet, close, tie-break. */
function ChainVote(p: { readonly view: ControlView | HostView; readonly mode: "control" | "host"; readonly act: Act; readonly m: ChainView }): JSX.Element {
  const name = (id: string | null) => nameOf(p.view, id);
  const v = () => p.m.vote;
  const control = () => p.mode === "control";
  const [voter, setVoter] = createSignal("");
  const [against, setAgainst] = createSignal("");
  const finished = () => p.m.over !== null || p.view.phase === "round.end";
  const earlier = () => chainOfEarlierRound(p.m, p.view.round);
  const close = async () => {
    const vote = v();
    if (vote === null) return;
    const missing = vote.voters.length - vote.cast;
    if (missing > 0 && !(await confirmDialog({ title: "Clore le vote maintenant ?", message: `${missing} joueur(s) n'ont pas encore voté : leur voix ne comptera pas.`, confirm: "Clore le vote", danger: true }))) return;
    await p.act({ type: "chain.closeVote" }, "Vote clos : le résultat est à l'antenne");
  };
  const pick = async (picker: string, out: string) => {
    if (await confirmDialog({ title: `Éliminer ${name(out)} ?`, message: `Choix du maillon fort (${name(picker)}), fait par la régie à sa place.`, confirm: `Éliminer ${name(out)}`, danger: true })) await p.act({ type: "chain.pick", participantId: picker, eliminated: out }, `${name(out)} quitte la partie`);
  };
  return (
    <section class="q-chain-vote" aria-label="Vote d'élimination">
      <span class="q-label">Vote d'élimination</span>
      <Show
        when={v()}
        fallback={
          <Show when={!earlier()}>
            <Show when={p.m.canOpenVote} fallback={<p class="muted">{finished() ? "Pas de vote possible ici (moins de 3 joueurs en jeu) : place à la suite." : "Le vote s'ouvre une fois la manche finie (« Fin de la manche »)."}</p>}>
              <p class="muted">La manche est finie : chaque joueur vote sur sa tablette contre un autre joueur.</p>
              <Show when={control()}>
                <div class="q-mech-row"><Button onClick={() => void p.act({ type: "chain.openVote" }, "Vote ouvert sur les tablettes")}>Ouvrir le vote d'élimination</Button></div>
              </Show>
            </Show>
          </Show>
        }
      >
        {(vote) => (
          <>
            <Show when={vote().status === "open"}>
              <p class="q-chain-progress"><b class="q-mono" data-testid="chain-cast">{vote().cast} / {vote().voters.length}</b> vote(s) reçu(s) · secret à l'antenne jusqu'à la clôture</p>
              <ul class="q-chain-ballots">
                <For each={vote().voters}>
                  {(id) => {
                    const ballot = () => vote().ballots?.find((b) => b.voter === id) ?? null;
                    return <li data-voted={String(ballot() !== null)}><span class="q-chain-name">{name(id)}</span><span class="muted">{ballot() === null ? "en attente" : `→ ${name(ballot()?.against ?? null)}`}</span></li>;
                  }}
                </For>
              </ul>
              <Show when={control()}>
                <details class="q-chain-proxy">
                  <summary>Voter à la place d'un joueur (tablette en panne)</summary>
                  <div class="q-mech-row">
                    <select aria-label="Joueur qui vote" value={voter()} onChange={(e) => setVoter(e.currentTarget.value)}>
                      <option value="">— qui vote —</option>
                      <For each={vote().voters}>{(id) => <option value={id}>{name(id)}</option>}</For>
                    </select>
                    <select aria-label="Contre qui" value={against()} onChange={(e) => setAgainst(e.currentTarget.value)}>
                      <option value="">— contre —</option>
                      <For each={vote().voters.filter((id) => id !== voter())}>{(id) => <option value={id}>{name(id)}</option>}</For>
                    </select>
                    <Button kind="secondary" disabled={voter() === "" || against() === "" || voter() === against()} onClick={() => void p.act({ type: "chain.vote", participantId: voter(), against: against() }, `Vote de ${name(voter())} enregistré`)}>Enregistrer ce vote</Button>
                  </div>
                </details>
                <div class="q-mech-row"><Button disabled={vote().cast === 0} title={vote().cast === 0 ? "Aucun vote reçu : les joueurs votent sur leur tablette (ou la régie vote pour eux)" : "Le plus de voix quitte la partie ; égalité : le maillon fort départage"} onClick={() => void close()}>Clore le vote</Button></div>
              </Show>
            </Show>
            <Show when={vote().tally}>
              {(tally) => (
                <ol class="q-chain-tally">
                  <For each={tally()}>{(t) => <li data-eliminated={String(vote().eliminated === t.participantId)}><span class="q-chain-name">{name(t.participantId)}</span><b class="q-mono">{t.votes}</b><span class="muted">voix</span></li>}</For>
                </ol>
              )}
            </Show>
            <Show when={vote().status === "tie" ? vote().picker : null}>
              {(picker) => (
                <div class="q-chain-tie">
                  <p class="q-mech-alert">Égalité entre {vote().tied.map((id) => name(id)).join(", ")} : le maillon fort, {name(picker())}, choisit sur sa tablette.</p>
                  <Show when={control()}>
                    <div class="q-mech-row">
                      <For each={vote().tied.filter((id) => id !== picker())}>{(id) => <Button kind="secondary" title={`Si ${name(picker())} ne peut pas choisir sur sa tablette`} onClick={() => void pick(picker(), id)}>Éliminer {name(id)} (pour {name(picker())})</Button>}</For>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={vote().eliminated}>{(id) => <p class="q-mech-ok" data-testid="chain-eliminated">{name(id())} quitte la partie (statut « éliminé »)</p>}</Show>
          </>
        )}
      </Show>
    </section>
  );
}
