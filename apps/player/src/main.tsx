import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { asChoice, asLadder, asPollBoard, nameOf, optionLetter, optionState, secondsLeft, sideName } from "@quiz/renderer";
import type { AnswerValue, PlayerView, Viewer } from "@quiz/schema";
import { StatusPill, createQuizConnection, tokenFromUrl, stakesLabel } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./player.css";
import { createKeepAwake, enterFullscreen } from "./keep-awake.ts";
import { MechanicInput } from "./MechanicInputs.tsx";

const PLAYER_TOKEN_KEY = "quiz.playerToken";

function storedToken(): string | null {
  try {
    return localStorage.getItem(PLAYER_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** `/play`: join with the game code + a nickname; the server creates the player and returns its own token. */
function Join(props: { onJoined: (token: string) => void }) {
  const [code, setCode] = createSignal(new URLSearchParams(location.search).get("code") ?? "");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code().trim(), name: name().trim() }) });
      const body: unknown = await res.json();
      if (!res.ok || typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
        setError(typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Impossible de rejoindre");
        return;
      }
      try {
        localStorage.setItem(PLAYER_TOKEN_KEY, body.token);
      } catch {
        /* private mode: the token lives for this page only */
      }
      props.onJoined(body.token);
    } catch {
      setError("Serveur injoignable : vérifier le Wi-Fi");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="p-join" onSubmit={(e) => void submit(e)}>
      <h1>Rejoindre la partie</h1>
      <label>
        Code de la partie
        <input inputmode="numeric" autocomplete="off" maxlength={6} value={code()} onInput={(e) => setCode(e.currentTarget.value)} required />
      </label>
      <label>
        Ton pseudo
        <input maxlength={40} value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
      </label>
      <Show when={error()}>
        <p class="p-error">{error()}</p>
      </Show>
      <button class="q-btn q-btn-big" type="submit" disabled={busy()}>
        {busy() ? "…" : "C'est parti"}
      </button>
    </form>
  );
}

function Game(props: { token: string }) {
  const conn = createQuizConnection({ token: props.token });
  const awake = createKeepAwake("/apps/player/keepawake.mp4");
  const [started, setStarted] = createSignal(false);
  const [sending, setSending] = createSignal<string | null>(null);
  const [lastError, setLastError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(conn.serverNow());
  const tick = setInterval(() => setNow(conn.serverNow()), 250);
  onCleanup(() => clearInterval(tick));

  const view = createMemo<PlayerView | null>(() => {
    const v = conn.view();
    return v !== null && v.role === "player" ? v : null;
  });
  // Clear the "sending" spinner as soon as the server view carries the answer.
  createEffect(() => {
    if (view()?.myAnswer !== null) setSending(null);
  });

  const [buzzing, setBuzzing] = createSignal(false);
  const buzz = async () => {
    const v = view();
    if (v === null || v.me === null || buzzing()) return;
    setBuzzing(true);
    navigator.vibrate?.(60);
    const ack = await conn.submit({ type: "buzz", participantId: v.me.participantId });
    setBuzzing(false);
    if (!ack.ok) setLastError(ack.reason);
  };

  /** Any typed / built answer (phase 3 mechanics). Saved on screen only once the server view carries it. */
  const send = async (answer: AnswerValue) => {
    const v = view();
    if (v === null || !v.canAnswer || v.me === null) return;
    setSending("answer");
    setLastError(null);
    navigator.vibrate?.(20);
    const ack = await conn.submit({ type: "answer.submit", participantId: v.me.participantId, answer });
    setSending(null);
    if (!ack.ok) setLastError(ack.reason);
  };

  const start = async () => {
    setStarted(true);
    await enterFullscreen();
    await awake.start();
  };

  const answer = async (optionId: string) => {
    const v = view();
    const m = v?.mechanic;
    if (v === null || !v.canAnswer || v.me === null || m === null || m === undefined || (m.mechanic !== "choice" && m.mechanic !== "ladder")) return;
    let ids = [optionId];
    if (m.mechanic === "choice" && m.maxPick > 1) {
      const cur = new Set(v.myAnswer ?? []);
      if (cur.has(optionId)) cur.delete(optionId);
      else cur.add(optionId);
      ids = [...cur].slice(0, m.maxPick);
      if (ids.length < m.minPick) return;
    }
    setSending(optionId);
    setLastError(null);
    navigator.vibrate?.(20);
    // Shown as saved ONLY after the server ack (doc 04): until then the intent stays queued and is resent.
    const ack = await conn.submit({ type: "answer.submit", participantId: v.me.participantId, answer: { kind: "choice", optionIds: ids } });
    setSending(null);
    if (!ack.ok) setLastError(ack.reason);
  };

  return (
    <div class="p-app" onClick={() => (started() ? undefined : void start())}>
      <header class="p-top">
        <span class="p-name">
          {/* Where am I: a fixed seat, or this phone's own player. */}
          <Show when={seatOf(conn.viewer())} fallback={<>{view()?.me?.displayName ?? "…"}<Show when={view()?.me}><span class="p-where"> · ce téléphone</span></Show></>}>
            {(n) => <>Siège {n()}<Show when={view()?.me}>{(me) => <> · {me().displayName}</>}</Show></>}
          </Show>
        </span>
        <Show when={view()?.me}>{(me) => <span class="p-score">{me().total} pts · {me().rank}ᵉ</span>}</Show>
        <StatusPill status={conn.status()} queued={conn.queued()} detail={conn.statusDetail()} />
      </header>
      <Switch>
        <Match when={conn.status() === "taken"}>
          <div class="p-center">
            <p class="p-big">Ouvert sur un autre appareil</p>
            <p>{conn.statusDetail() ?? "Ce siège est maintenant utilisé ailleurs."} Cet écran ne joue plus, pour que personne ne prenne la place d'un autre.</p>
            <button class="q-btn" type="button" onClick={() => location.reload()}>Reprendre sur cet appareil</button>
          </div>
        </Match>
        <Match when={conn.status() === "rejected"}>
          <div class="p-center">
            <p>Ce lien n'est plus valable.</p>
            <button class="q-btn" type="button" onClick={() => { try { localStorage.removeItem(PLAYER_TOKEN_KEY); } catch { /* ignore */ } location.reload(); }}>Rejoindre à nouveau</button>
          </div>
        </Match>
        <Match when={!started()}>
          <div class="p-center p-start">
            <p class="p-big">Touchez l'écran pour commencer</p>
            <p class="muted">L'écran restera allumé pendant la partie.</p>
          </div>
        </Match>
        <Match when={view() === null}>
          <div class="p-center">Connexion…</div>
        </Match>
        <Match when={view()?.me === null && conn.viewer()?.role === "player"}>
          {/* /play player whose game was replaced by a new one: join the new game. */}
          <div class="p-center">
            <p class="p-big">Nouvelle partie</p>
            <button class="q-btn q-btn-big" type="button" onClick={() => { try { localStorage.removeItem(PLAYER_TOKEN_KEY); } catch { /* ignore */ } location.assign("/play"); }}>Rejoindre</button>
          </div>
        </Match>
        <Match when={view()?.me === null}>
          <ClaimSeat seat={seatOf(conn.viewer())} />
        </Match>
        <Match when={view()?.question === null || view()?.mechanic === null}>
          <div class="p-center">
            <p class="p-big">{view()?.phase === "game.end" ? "Partie terminée !" : view()?.mechanic?.mechanic === "board" ? "La régie choisit une case…" : "Prochaine question dans un instant…"}</p>
            <Show when={view()?.me}>{(me) => <p class="p-rank">{me().rank}ᵉ · {me().total} pts</p>}</Show>
          </div>
        </Match>
        <Match when={view()}>
          {(v) => (
            <main class="p-question">
              <div class="p-meta">
                <span>Question {(v().question?.index ?? 0) + 1} / {v().question?.count}</span>
                <Show when={stakesLabel(v().stakes)}>{(t) => <span class="q-stakes-badge">{t()}</span>}</Show>
                <Show when={v().timer}>{(t) => <span class={`p-timer${secondsLeft(t().endsAt, now()) <= 5 ? " p-timer-low" : ""}`}>{secondsLeft(t().endsAt, now())}<small> s</small></span>}</Show>
              </div>
              <h1 class="p-prompt">{v().question?.prompt.text}</h1>
              <Show when={asChoice(v().mechanic)}>
                {(mm) => {
                  const m = () => mm();
                  return (
                    <>
                    {/* Several answers: each touch ticks or unticks one (saved at once); said before the options. */}
                    <Show when={m().maxPick > 1 && v().phase !== "revealed"}>
                      <p class="p-hint p-multi-hint">Plusieurs réponses possibles : touchez toutes celles qui sont justes{m().maxPick < m().options.length ? ` (${m().maxPick} au plus)` : ""}.</p>
                    </Show>
                    <div class="p-options" data-count={m().options.length}>
                      <For each={m().options}>
                        {(o, i) => {
                          const mine = () => v().myAnswer?.includes(o.id) === true;
                          // A vote: no wrong answer — my choice stays « selected », the winning one(s) « correct ».
                          const state = () => (m().correct !== null ? (m().correct?.includes(o.id) === true ? "correct" : mine() ? (m().kind === "vote" ? "selected" : "wrong") : "idle") : mine() ? "selected" : sending() === o.id ? "sending" : "idle");
                          return (
                            <button type="button" class="p-option" data-state={state()} disabled={!v().canAnswer || (sending() !== null && sending() !== o.id)} onClick={() => void answer(o.id)}>
                              <span class="p-letter">{optionLetter(i())}</span>
                              <span class="p-label">{o.label}</span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                    </>
                  );
                }}
              </Show>
              <Show when={asLadder(v().mechanic)}>
                {(m) => {
                  const mine = () => m().candidate === null || m().candidate === v().me?.participantId;
                  return (
                    <>
                      <p class="p-ladder">Palier {m().level + 1} / {m().steps.length} · en jeu : {(m().atStake ?? 0).toLocaleString("fr-FR")} · assuré : {m().secured.toLocaleString("fr-FR")}</p>
                      <Show when={!mine()}><p class="muted">C'est au tour de {nameOf(v(), m().candidate)}.</p></Show>
                      <div class="p-options" data-count={m().options.length}>
                        <For each={m().options}>
                          {(o, i) => (
                            <button type="button" class="p-option" data-state={sending() === o.id ? "sending" : optionState(m(), o.id, v().myAnswer, v().phase)} disabled={!mine() || !v().canAnswer || m().hidden.includes(o.id) || sending() !== null} onClick={() => void answer(o.id)}>
                              <span class="p-letter">{optionLetter(i())}</span>
                              <span class="p-label">{m().hidden.includes(o.id) ? "" : o.label}</span>
                              <Show when={m().audience}>{(a) => <span class="p-share">{a()[o.id] ?? 0} %</span>}</Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </>
                  );
                }}
              </Show>
              <Show when={v().question?.id} keyed>
                {(_id: string) => <MechanicInput view={v()} send={send} sending={sending() !== null} mediaUrl={conn.mediaUrl} buzz={buzz} buzzing={buzzing()} />}
              </Show>
              <Show when={asPollBoard(v().mechanic)}>
                {(m) => (
                  <div class="p-poll">
                    {/* Who answers now: this player / team, or someone else (survey played orally). */}
                    {(() => {
                      const me = v().me;
                      const mine = (side: string | null) => side !== null && me !== null && (side === me.participantId || side === me.teamId);
                      const other = (side: string | null) => { const n = sideName(v(), side); return n === "—" ? "un autre joueur" : n; };
                      return (
                        <Show when={m().stage !== "done" && v().phase !== "revealed" && (m().controllingTeamId !== null || m().stealingTeamId !== null)}>
                          <Show
                            when={m().stage === "steal" ? mine(m().stealingTeamId) : mine(m().controllingTeamId)}
                            fallback={<p class="p-hand-other">{m().stage === "steal" && m().stealingTeamId !== null ? `Tentative de vol : ${other(m().stealingTeamId)}` : `La main est à ${other(m().controllingTeamId)}`}</p>}
                          >
                            <p class="p-hand-mine">{m().stage === "steal" ? "Vol : à vous ! Une seule réponse" : "À vous ! Vous avez la main"}</p>
                          </Show>
                        </Show>
                      );
                    })()}
                    <For each={m().slots}>{(s) => <div class="p-slot" data-found={String(s.found)}><span>{s.index + 1}</span><span>{s.revealed ? s.label : "…"}</span><b>{s.revealed ? s.value : ""}</b></div>}</For>
                    <p class="p-strikes">{"✗".repeat(m().strikes)}<span class="muted">{"✗".repeat(Math.max(0, m().maxStrikes - m().strikes))}</span></p>
                    <p class="muted">Réponse à l'oral : l'animateur valide.</p>
                  </div>
                )}
              </Show>
              <footer class="p-feedback" role="status" data-tone={feedbackTone(v(), sending() !== null, lastError() !== null)}>
                <Switch>
                  <Match when={v().myResult === "correct"}>✓ Bonne réponse !</Match>
                  <Match when={v().myResult === "partial"}>◐ En partie juste</Match>
                  <Match when={v().myResult === "wrong"}>✗ Raté…</Match>
                  <Match when={v().myResult === "none" && v().phase === "revealed" && asChoice(v().mechanic)?.kind === "vote" && v().myAnswer !== null}>Merci pour ton vote !</Match>
                  <Match when={v().myResult === "none" && v().phase === "revealed"}>Pas de réponse</Match>
                  <Match when={sending() !== null}>Envoi…</Match>
                  <Match when={lastError()}>{lastError()}</Match>
                  <Match when={v().myAnswer !== null && v().canAnswer}>Réponse enregistrée ✓<small>Modifiable jusqu'à la fin du chrono</small></Match>
                  <Match when={v().myAnswer !== null}>Réponse enregistrée ✓</Match>
                  <Match when={v().phase === "presenting"}>Lisez la question…</Match>
                  {/* Survey: answered orally, by whoever has the hand (said above the board), never by every tablet. */}
                  <Match when={asPollBoard(v().mechanic) !== null && v().phase !== "revealed"}>{null}</Match>
                  <Match when={v().phase === "open" && v().canAnswer}>À vous !</Match>
                  <Match when={v().phase === "locked" || v().phase === "judging"}>Réponses fermées</Match>
                </Switch>
              </footer>
            </main>
          )}
        </Match>
      </Switch>
    </div>
  );
}

/** Colour of the status line: amber while sending / your turn, green saved or right, red wrong or refused. */
function feedbackTone(v: PlayerView, sending: boolean, error: boolean): string {
  if (v.myResult === "correct" || v.myResult === "partial") return "ok";
  if (v.myResult === "wrong") return "no";
  if (v.phase === "revealed") return "idle";
  if (sending) return "busy";
  if (error) return "no";
  if (v.myAnswer !== null) return "ok";
  if (v.phase === "open" && v.canAnswer) return "busy";
  return "idle";
}

const seatOf = (v: Viewer | null): number | null => (v !== null && v.role === "seat" ? v.seat : null);

/** Free seat: the player types their name and sits down (or the control room seats someone). */
function ClaimSeat(p: { seat: number | null }) {
  const [name, setName] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (name().trim() === "") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/seat/claim?t=${encodeURIComponent(tokenFromUrl())}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name().trim() }) });
      if (!r.ok) {
        const body: unknown = await r.json().catch(() => ({}));
        setErr(typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `refusé (${r.status})`);
      }
      // Accepted: the next view carries `me` and this screen goes away by itself.
    } catch {
      setErr("Serveur injoignable : réessayer");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="p-center p-claim" onSubmit={(e) => void submit(e)}>
      <p class="p-claim-seat q-mono">SIÈGE {p.seat ?? "?"}</p>
      <p class="p-big">Siège libre</p>
      <label class="p-claim-field">
        <span>Votre prénom ou pseudo</span>
        <input value={name()} maxlength={40} autocomplete="off" autocapitalize="words" onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <Show when={err()}>{(m) => <p class="p-claim-err">{m()}</p>}</Show>
      <button class="q-btn q-btn-big" type="submit" disabled={busy() || name().trim() === ""}>Je m'installe</button>
      <p class="muted">Ou attendez : la régie peut aussi vous attribuer ce siège.</p>
    </form>
  );
}

function App() {
  const isSeat = location.pathname.startsWith("/seat/");
  const [token, setToken] = createSignal<string | null>(isSeat ? tokenFromUrl() : (tokenFromUrl() || storedToken()));
  return (
    <Show when={token()} fallback={<Join onJoined={setToken} />}>
      {(t) => <Game token={t()} />}
    </Show>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
