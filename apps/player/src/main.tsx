import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { optionLetter, secondsLeft } from "@quiz/renderer";
import type { PlayerView } from "@quiz/schema";
import { StatusPill, createQuizConnection, tokenFromUrl } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./player.css";
import { createKeepAwake, enterFullscreen } from "./keep-awake.ts";

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

  const start = async () => {
    setStarted(true);
    await enterFullscreen();
    await awake.start();
  };

  const answer = async (optionId: string) => {
    const v = view();
    const m = v?.mechanic;
    if (v === null || !v.canAnswer || v.me === null || m === null || m === undefined || m.mechanic !== "choice") return;
    let ids = [optionId];
    if (m.maxPick > 1) {
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
        <span class="p-name">{view()?.me?.displayName ?? "…"}</span>
        <Show when={view()?.me}>{(me) => <span class="p-score">{me().total} pts · {me().rank}ᵉ</span>}</Show>
        <StatusPill status={conn.status()} queued={conn.queued()} detail={conn.statusDetail()} />
      </header>
      <Switch>
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
          <div class="p-center">
            <p class="p-big">Tablette prête</p>
            <p class="muted">La régie va vous attribuer ce siège.</p>
          </div>
        </Match>
        <Match when={view()?.question === null || view()?.mechanic === null}>
          <div class="p-center">
            <p class="p-big">{view()?.phase === "game.end" ? "Partie terminée !" : "Prochaine question dans un instant…"}</p>
            <Show when={view()?.me}>{(me) => <p class="p-rank">{me().rank}ᵉ · {me().total} pts</p>}</Show>
          </div>
        </Match>
        <Match when={view()}>
          {(v) => (
            <main class="p-question">
              <div class="p-meta">
                <span>Question {(v().question?.index ?? 0) + 1} / {v().question?.count}</span>
                <Show when={v().timer}>{(t) => <span class={`p-timer${secondsLeft(t().endsAt, now()) <= 5 ? " p-timer-low" : ""}`}>⏱ {secondsLeft(t().endsAt, now())}</span>}</Show>
              </div>
              <h1 class="p-prompt">{v().question?.prompt.text}</h1>
              <Show when={v().mechanic?.mechanic === "choice" ? v().mechanic : null}>
                {(mm) => {
                  const m = () => {
                    const x = mm();
                    if (x.mechanic !== "choice") throw new Error("unreachable");
                    return x;
                  };
                  return (
                    <div class="p-options" data-count={m().options.length}>
                      <For each={m().options}>
                        {(o, i) => {
                          const mine = () => v().myAnswer?.includes(o.id) === true;
                          const state = () => (m().correct !== null ? (m().correct?.includes(o.id) === true ? "correct" : mine() ? "wrong" : "idle") : mine() ? "selected" : sending() === o.id ? "sending" : "idle");
                          return (
                            <button type="button" class="p-option" data-state={state()} disabled={!v().canAnswer || (sending() !== null && sending() !== o.id)} onClick={() => void answer(o.id)}>
                              <span class="p-letter">{optionLetter(i())}</span>
                              <span class="p-label">{o.label}</span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  );
                }}
              </Show>
              <footer class="p-feedback" role="status">
                <Switch>
                  <Match when={v().myResult === "correct"}>✓ Bonne réponse !</Match>
                  <Match when={v().myResult === "wrong"}>✗ Raté…</Match>
                  <Match when={v().myResult === "none" && v().phase === "revealed"}>Pas de réponse</Match>
                  <Match when={sending() !== null}>Envoi…</Match>
                  <Match when={lastError()}>{lastError()}</Match>
                  <Match when={v().myAnswer !== null && v().canAnswer}>Réponse enregistrée ✓ (modifiable jusqu'à la fin du chrono)</Match>
                  <Match when={v().myAnswer !== null}>Réponse enregistrée ✓</Match>
                  <Match when={v().phase === "presenting"}>Lisez la question…</Match>
                  <Match when={v().phase === "locked"}>Réponses fermées</Match>
                </Switch>
              </footer>
            </main>
          )}
        </Match>
      </Switch>
    </div>
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
