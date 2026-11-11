import { For, Show, type JSX } from "solid-js";
import { formatNumber } from "./answers.ts";
import { asChain, chainOfEarlierRound, chainOverText, chainSteps, duelScores, type ChainView } from "./chain.ts";
import { nameOf } from "./logic.ts";
import { panel, type ZoneProps } from "./zone-kit.tsx";

/**
 * « La chaîne » on air (ADR-0016), drawn inside the existing zone types of the program scene: the `ladder` zone shows
 * the chain (steps, current one lit, bank), the `buzzer` zone whose turn it is, the `leaderboard` zone — between turns
 * and between rounds — the round figures, the elimination vote and the duel score. Read only from the view.
 */

const tabular: JSX.CSSProperties = { "font-variant-numeric": "tabular-nums" };

/** Duel: the two players, right answers out of the questions each, the winner lit. */
function DuelScore(p: { readonly view: ZoneProps["view"]; readonly m: ChainView; readonly size: number }): JSX.Element {
  return (
    <div class="q-chain-duel" style={{ display: "grid", gap: `${Math.round(p.size * 0.4)}px` }}>
      <For each={duelScores(p.m)}>
        {(s) => {
          const won = () => p.m.duel?.winner === s.participantId;
          const turn = () => p.m.turn === s.participantId && p.m.duel?.winner === null;
          return (
            <div class="q-chain-duel-row" data-winner={String(won())} data-turn={String(turn())} style={{ ...panel, display: "flex", "align-items": "center", gap: "16px", padding: `0 ${Math.round(p.size * 0.6)}px`, height: `${Math.round(p.size * 2)}px`, "font-size": `${p.size}px`, "background-color": won() ? "var(--q-color-correct)" : turn() ? "var(--q-color-surface-alt)" : "var(--q-color-surface)", outline: turn() ? "3px solid var(--q-color-accent)" : "none" }}>
              <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{nameOf(p.view, s.participantId)}</span>
              <b style={{ ...tabular, color: won() ? "var(--q-color-text)" : "var(--q-color-accent)" }}>{s.right}</b>
              <span style={{ ...tabular, "font-size": `${Math.round(p.size * 0.55)}px`, color: "var(--q-color-muted)" }}>/ {s.asked}</span>
            </div>
          );
        }}
      </For>
      <Show when={p.m.duel?.suddenDeath === true && p.m.duel.winner === null}>
        <span style={{ "font-size": `${Math.round(p.size * 0.6)}px`, color: "var(--q-color-wrong)", "text-align": "center" }}>Mort subite</span>
      </Show>
    </div>
  );
}

/** `ladder` zone in a chain round: steps top-down (current lit, next outlined), the bank below. Duel: the score. */
export function ChainLadderZone(p: ZoneProps): JSX.Element {
  return (
    <Show when={asChain(p.view.mechanic)}>
      {(m) => (
        <Show when={m().stage === "chain"} fallback={<div style={{ width: "100%", height: "100%", display: "flex", "flex-direction": "column", "justify-content": "center" }}><DuelScore view={p.view} m={m()} size={Math.max(20, Math.min(40, p.zone.rect.h / 7))} /></div>}>
          {(() => {
            // Rows fill the zone (bank line and gaps taken off): ≈ 40 px for 9 steps in the program preset (400 × 480).
            const rowH = () => { const n = Math.max(1, m().steps.length); return Math.max(16, Math.min(52, (p.zone.rect.h - 96 - 3 * (n - 1)) / n)); };
            return (
              <div class="q-chain-ladder" style={{ ...panel, width: "100%", height: "100%", padding: "10px 14px", display: "flex", "flex-direction": "column", gap: "3px" }}>
                <For each={chainSteps(m())}>
                  {(r) => (
                    <div class="q-chain-step" data-state={r.state} style={{ display: "flex", "justify-content": "center", "align-items": "center", height: `${rowH()}px`, "border-radius": "calc(var(--q-radius) / 2)", "font-size": `${Math.round(rowH() * 0.66)}px`, "font-weight": r.state === "current" ? 900 : 700, ...tabular, background: r.state === "current" ? "var(--q-color-accent)" : r.state === "climbed" ? "var(--q-color-primary)" : "transparent", color: r.state === "current" || r.state === "climbed" ? "var(--q-color-surface)" : "var(--q-color-muted)", "box-shadow": r.state === "next" ? "inset 0 0 0 2px var(--q-color-accent)" : "none", transition: "background var(--q-motion), color var(--q-motion)" }}>
                      {formatNumber(r.amount)}
                    </div>
                  )}
                </For>
                <div class="q-chain-bank" style={{ "margin-top": "auto", display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: "10px", padding: "6px 4px 0", "border-top": "2px solid var(--q-color-surface-alt)" }}>
                  <span style={{ "font-size": "22px", color: "var(--q-color-muted)" }}>Banque</span>
                  <b style={{ ...tabular, "font-size": "40px", color: "var(--q-color-correct)" }}>{formatNumber(m().bank)}</b>
                </div>
              </div>
            );
          })()}
        </Show>
      )}
    </Show>
  );
}

/** `buzzer` zone in a chain round: whose question it is, coloured by the verdict once judged; the duel winner. */
export function ChainTurnZone(p: ZoneProps): JSX.Element {
  const fs = () => `${Math.round(p.zone.rect.h * 0.42)}px`;
  return (
    <Show when={asChain(p.view.mechanic)}>
      {(m) => {
        const winner = () => m().duel?.winner ?? null;
        const who = () => winner() ?? m().turn;
        const bg = () => (winner() !== null || m().verdict === "right" ? "var(--q-color-correct)" : m().verdict === "wrong" ? "var(--q-color-wrong)" : "var(--q-color-primary)");
        return (
          <Show when={who()}>
            {(id) => (
              <div class="q-chain-turn" data-verdict={m().verdict ?? "none"} style={{ ...panel, width: "100%", height: "100%", display: "flex", "align-items": "center", "justify-content": "center", gap: "18px", "font-size": fs(), "background-color": bg(), transition: "background var(--q-motion)" }}>
                <span style={{ overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{nameOf(p.view, id())}</span>
                <Show when={winner() !== null}><span>remporte {formatNumber(m().totalBank)}</span></Show>
                <Show when={winner() === null && m().verdict !== null}><span>{m().verdict === "right" ? "✓" : "✗"}</span></Show>
              </div>
            )}
          </Show>
        );
      }}
    </Show>
  );
}

/** `leaderboard` zone while a chain game is between turns / rounds: round figures, the vote, the duel. */
export function ChainBoardZone(p: ZoneProps & { readonly m: ChainView }): JSX.Element {
  const m = () => p.m;
  const name = (id: string | null) => nameOf(p.view, id);
  // A new round has started but not played yet: the figures and the vote of the round before are history, not on air.
  const fresh = () => chainOfEarlierRound(m(), p.view.round);
  const title = () => (m().vote !== null ? "Vote d'élimination" : m().stage === "duel" ? "Duel final" : "La chaîne");
  const inGame = () => m().order.filter((id) => !m().eliminations.some((e) => e.participantId === id));
  return (
    <Show when={!fresh()} fallback={
      <div class="q-chain-board" data-fresh="true" style={{ ...panel, width: "100%", height: "100%", padding: "28px 36px", display: "flex", "flex-direction": "column", gap: "18px", "font-size": "34px" }}>
        <div style={{ "font-size": "44px", color: "var(--q-color-accent)" }}>{p.view.round?.title ?? "La chaîne"}</div>
        <div><div style={{ "font-size": "24px", color: "var(--q-color-muted)" }}>Cagnotte de la partie</div><b style={{ ...tabular, "font-size": "64px" }}>{formatNumber(m().totalBank)}</b></div>
        <div style={{ "font-size": "24px", color: "var(--q-color-muted)" }}>En jeu</div>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "12px" }}>
          <For each={inGame()}>{(id) => <span style={{ padding: "8px 18px", background: "var(--q-color-surface-alt)", "border-radius": "calc(var(--q-radius) / 2)" }}>{name(id)}</span>}</For>
        </div>
      </div>
    }>
    <div class="q-chain-board" style={{ ...panel, width: "100%", height: "100%", padding: "28px 36px", display: "flex", "flex-direction": "column", gap: "14px", "font-size": "32px" }}>
      <div style={{ "font-size": "40px", color: "var(--q-color-accent)" }}>{title()}</div>
      <Show
        when={m().vote}
        fallback={
          <Show when={m().stage === "chain"} fallback={<DuelScore view={p.view} m={m()} size={44} />}>
            <div style={{ display: "flex", gap: "24px" }}>
              <div style={{ flex: 1 }}><div style={{ "font-size": "24px", color: "var(--q-color-muted)" }}>Banque de la manche</div><b class="q-chain-round-bank" style={{ ...tabular, "font-size": "56px", color: "var(--q-color-correct)" }}>{formatNumber(m().bank)}</b></div>
              <div style={{ flex: 1, "text-align": "right" }}><div style={{ "font-size": "24px", color: "var(--q-color-muted)" }}>Cagnotte de la partie</div><b class="q-chain-total" style={{ ...tabular, "font-size": "56px" }}>{formatNumber(m().totalBank)}</b></div>
            </div>
            <Show when={chainOverText(m().over)}>{(t) => <div style={{ "font-size": "26px", color: "var(--q-color-muted)" }}>{t()}</div>}</Show>
            <div style={{ display: "grid", gap: "8px" }}>
              <For each={m().stats}>
                {(s) => {
                  const tag = () => (m().over === null ? null : s.participantId === m().strongest ? "Maillon fort" : s.participantId === m().weakest ? "Maillon faible" : null);
                  return (
                    <div class="q-chain-stat" style={{ display: "flex", "align-items": "center", gap: "20px", height: "64px", padding: "0 20px", background: "var(--q-color-surface-alt)", "border-radius": "calc(var(--q-radius) / 2)" }}>
                      <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{name(s.participantId)}</span>
                      <Show when={tag()}>{(t) => <span style={{ "font-size": "22px", padding: "2px 10px", "border-radius": "var(--q-radius)", background: t() === "Maillon fort" ? "var(--q-color-correct)" : "var(--q-color-wrong)" }}>{t()}</span>}</Show>
                      <span style={{ ...tabular, color: "var(--q-color-correct)" }}>✓ {s.right}</span>
                      <span style={{ ...tabular, color: "var(--q-color-muted)" }}>✗ {s.wrong}</span>
                      <span style={{ ...tabular, width: "140px", "text-align": "right" }}>{formatNumber(s.banked)}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        }
      >
        {(v) => (
          <>
            <Show when={v().status === "open"}>
              <div class="q-chain-vote-open" style={{ "font-size": "36px" }}>Les joueurs votent… <b style={tabular}>{v().cast} / {v().voters.length}</b></div>
            </Show>
            <Show when={v().tally}>
              {(tally) => {
                const max = () => Math.max(1, ...tally().map((t) => t.votes));
                return (
                  <div style={{ display: "grid", gap: "10px" }}>
                    <For each={tally()}>
                      {(t) => {
                        const out = () => v().eliminated === t.participantId;
                        return (
                          <div class="q-chain-tally" data-eliminated={String(out())} style={{ position: "relative", overflow: "hidden", display: "flex", "align-items": "center", gap: "20px", height: "72px", padding: "0 22px", background: "var(--q-color-surface-alt)", "border-radius": "calc(var(--q-radius) / 2)", opacity: v().status === "done" && !out() ? 0.6 : 1 }}>
                            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round((t.votes / max()) * 100)}%`, background: out() ? "var(--q-color-wrong)" : "rgba(255,255,255,.12)", transition: "width var(--q-motion)" }} />
                            <span style={{ position: "relative", flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{name(t.participantId)}</span>
                            <b style={{ position: "relative", ...tabular }}>{t.votes} voix</b>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                );
              }}
            </Show>
            <Show when={v().status === "tie"}>
              <div class="q-chain-tie" style={{ "font-size": "32px", color: "var(--q-color-accent)" }}>Égalité : {v().tied.map((id) => name(id)).join(", ")} — {name(v().picker)} (maillon fort) départage</div>
            </Show>
            <Show when={v().eliminated}>
              {(id) => <div class="q-chain-out" style={{ "font-size": "44px", "font-weight": 900, color: "var(--q-color-wrong)" }}>{name(id())} quitte la partie</div>}
            </Show>
          </>
        )}
      </Show>
    </div>
    </Show>
  );
}
