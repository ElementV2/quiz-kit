import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { Action, HostView } from "@quiz/schema";
import { nextStep } from "@quiz/protocol";
import { secondsLeft } from "@quiz/renderer";
import { ConfirmKey, CrowdVotePanel, HomeLink, ON_AIR_PHASES, PHASE_LABEL, StatusPill, createQuizConnection, nextTarget, onAirTarget, questionAt, type Target, StakesBar } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./host.css";
import { DriveTools, Judge } from "./Judge.tsx";
import { presentOffer, reading, timecode } from "./logic.ts";
import { Prompter } from "./Prompter.tsx";
import { RundownDrawer } from "./Rundown.tsx";

/**
 * /host — the host's prompter (doc 08). Always shows the question to READ (on air, else the next one), its
 * answer and notes; judging in one tap; and, when the control room lets the host drive, the flow keys.
 * Never on air. Every key is an intent: the server refuses what the host may not do.
 */
function App() {
  const conn = createQuizConnection();
  const view = createMemo<HostView | null>(() => {
    const v = conn.view();
    return v !== null && v.role === "host" ? v : null;
  });
  const [now, setNow] = createSignal(conn.serverNow());
  const tick = setInterval(() => setNow(conn.serverNow()), 250);
  onCleanup(() => clearInterval(tick));
  const [preview, setPreview] = createSignal<Target | null>(null);
  const [drawer, setDrawer] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(noticeTimer));

  const onAir = createMemo(() => {
    const v = view();
    return v === null ? null : onAirTarget(v);
  });
  // A new question on air always brings the prompter back to it.
  createEffect(on(() => `${onAir()?.roundIndex ?? ""}:${onAir()?.questionIndex ?? ""}`, () => setPreview(null), { defer: true }));

  const act = async (a: Action): Promise<boolean> => {
    const ack = await conn.submit(a);
    clearTimeout(noticeTimer);
    setNotice(ack.ok ? null : `Refusé : ${ack.reason}`);
    if (!ack.ok) noticeTimer = setTimeout(() => setNotice(null), 6000);
    return ack.ok;
  };
  /** Several intents in a row (start the round, then present): stops at the first refusal. */
  const run = async (steps: readonly Action[]) => {
    for (const s of steps) if (!(await act(s))) return;
  };

  return (
    <div class="h-app">
      <Show when={view()} fallback={<div class="h-wait-screen"><StatusPill status={conn.status()} detail={conn.statusDetail()} /><p>Connexion au serveur de show…</p></div>}>
        {(v) => {
          const read = createMemo(() => reading(v(), preview()));
          const next = createMemo(() => nextTarget(v()));
          const step = () => (v().drive ? nextStep(v()) : null);
          const remaining = () => {
            const t = v().timer;
            return t === null ? null : secondsLeft(t.endsAt, now());
          };
          const answered = () => {
            const m = v().mechanic;
            return m !== null && "answeredCount" in m ? m.answeredCount : null;
          };
          const offer = () => {
            const r = read();
            return r === null || r.mode !== "preview" ? null : presentOffer(v(), r.target, r.question.played);
          };
          const inQuestion = () => v().phase === "presenting" || v().phase === "open" || v().phase === "locked" || v().phase === "judging";
          return (
            <>
              <header class="h-top">
                <button type="button" class="q-btn q-btn-secondary h-rundown-btn" onClick={() => setDrawer(true)}>Déroulé</button>
                <span class="h-where">
                  <span class="h-where-round">{v().round?.title ?? ""}</span>
                  <Show when={v().question}>{(q) => <span class="q-mono"> · Q{q().index + 1}/{q().count}</span>}</Show>
                </span>
                <span class="h-spacer" />
                <span class="q-tally" data-on={ON_AIR_PHASES.has(v().phase) ? "air" : undefined}>{PHASE_LABEL[v().phase]}</span>
                <span class="q-tally" data-on={v().drive ? "armed" : undefined} title={v().drive ? "La régie vous laisse piloter le déroulé" : "La régie pilote le déroulé"}>{v().drive ? "Vous pilotez" : "Pilotage : régie"}</span>
                <StatusPill status={conn.status()} queued={conn.queued()} detail={conn.statusDetail()} />
                <HomeLink />
              </header>

              <main class="h-main">
                <Show when={read()} fallback={<section class="h-prompter h-empty"><p class="h-question">{v().phase === "game.end" ? "Partie terminée." : "La régie choisit la prochaine question."}</p><p class="h-small">Ouvrez le déroulé pour lire les questions à venir.</p></section>}>
                  {(r) => (
                    <Prompter
                      view={v()}
                      reading={r()}
                      mediaUrl={conn.mediaUrl}
                      offer={offer()}
                      onBack={() => setPreview(null)}
                      onPresent={() => {
                        const o = offer();
                        if (o !== null && o.ok) void run(o.steps).then(() => setPreview(null));
                      }}
                    />
                  )}
                </Show>

                <aside class="h-desk">
                  <div class="h-clock" data-low={String((remaining() ?? 99) <= 5)}>
                    <Show when={remaining() !== null} fallback={<span class="h-clock-none">Pas de chrono</span>}>
                      <span class="h-clock-time q-mono">{timecode(remaining() ?? 0)}</span>
                    </Show>
                    <span class="h-clock-meta">
                      <Show when={answered() !== null}>
                        <span><b class="q-mono">{answered()}</b> réponse(s)</span>
                      </Show>
                    </span>
                  </div>

                  <div class="h-desk-body">
                    <Judge view={v()} act={act} />
                    <CrowdVotePanel mechanic={v().mechanic} />
                    <Show when={read()?.mode === "onair" ? questionAt(v().rundown, next()) : null}>
                      {(q) => <p class="h-then"><span class="q-label">Ensuite</span> {q().text}</p>}
                    </Show>
                  </div>

                  <Show when={v().drive} fallback={<p class="h-small h-desk-foot">La régie pilote le déroulé. Vous validez les réponses.</p>}>
                    {/*
                      Fixed places, bottom-up (thumb zone): the next step is ALWAYS the last key, « Passer » just above,
                      then Révéler / +10 s (always there, greyed when useless). Tools that depend on the question
                      (jokers, stakes…) come above them, so they never push the main keys around.
                    */}
                    <div class="h-keys">
                      <div class="h-keys-tools">
                        <DriveTools view={v()} act={act} />
                        <Show when={v().mechanic?.mechanic !== "chain"}><StakesBar class="h-stakes" view={v()} act={(a) => act(a)} /></Show>
                      </div>
                      <div class="h-keys-grid">
                        <button type="button" class="h-key" disabled={v().phase !== "open"} onClick={() => void run([{ type: "question.lock" }, { type: "question.reveal" }])}>Révéler</button>
                        <button type="button" class="h-key" disabled={v().phase !== "open"} onClick={() => { const t = v().timer; void act({ type: "timer.set", remainingMs: Math.max(0, (t?.endsAt ?? now()) - now()) + 10_000 }); }}>+10 s</button>
                        <Show
                          when={!inQuestion() && v().phase === "idle" && v().round !== null ? nextTarget(v()) : null}
                          fallback={<ConfirmKey class="h-key h-key-wide" label="Passer la question" confirmLabel="Confirmer : passer sans révéler ?" disabled={!inQuestion()} onConfirm={() => void act({ type: "question.next" })} />}
                        >
                          {(t) => <ConfirmKey class="h-key h-key-wide" label="Passer la question" confirmLabel="Confirmer : passer la suivante sans la jouer ?" onConfirm={() => void act({ type: "question.skip", ...t() })} />}
                        </Show>
                      </div>
                      <Show when={step()} fallback={<button type="button" class="h-key h-key-primary" disabled>Partie terminée</button>}>
                        {(s) => <button type="button" class="h-key h-key-primary" disabled={s().action === null} onClick={() => { const a = s().action; if (a !== null) void act(a); }}>{s().label}</button>}
                      </Show>
                    </div>
                  </Show>
                  <Show when={notice()}>{(n) => <p class="h-notice" role="alert">{n()}</p>}</Show>
                </aside>
              </main>

              <Show when={drawer()}>
                <RundownDrawer
                  view={v()}
                  onAir={onAir()}
                  next={next()}
                  selected={preview()}
                  onClose={() => setDrawer(false)}
                  onPick={(t) => {
                    setPreview(t);
                    setDrawer(false);
                  }}
                />
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
