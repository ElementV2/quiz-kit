import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Action as ActionSchema, actionLabel, type Action, type ControlView } from "@quiz/schema";
import { asChoice, optionLetter, secondsLeft } from "@quiz/renderer";
import { Button, HomeLink, MECHANIC_LABEL, MechanicPanel, VerdictsPanel, ON_AIR_PHASES, PHASE_LABEL, StatusPill, createQuizConnection, formatAnswer, nextTarget, onAirTarget, questionAt, sameTarget, confirmDialog, isDialogOpen, StakesBar } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./control.css";
import { api, lanOrigin, token, withToken, type LinksResponse, type StatusResponse } from "./api.ts";
import { LedgerPanel } from "./Ledger.tsx";
import { StandbyBar } from "./Standby.tsx";
import { ApiInfo, ChatPanel, StaffCode } from "./Integrations.tsx";
import { KeyBuzzersPanel, createKeyBuzzers } from "./KeyBuzzers.tsx";
import { checklist, nextStep } from "./logic.ts";
import { GameImport, LayersPanel, LibraryPanel, LinksList, Players, ProgramPreview, TeamsPanel, useLayers } from "./Panels.tsx";
import { PastVerdicts, QuestionTextEdit, RegradeEditor, RehearsalPanel, ReserveList, ResultsPanel } from "./ShowTools.tsx";

/**
 * /control — the control room (doc 08), organised around the live task:
 * top bar (show, phase, tally, code, host drive) · left run-down · centre the ONE next-step key and the question
 * on air · right the program monitor and ONE open section at a time (players, layers, tools, checklist).
 */

type Act = (a: Action, ok?: string) => Promise<boolean>;
type Tab = "games" | "players" | "layers" | "tools" | "check";

const ACTION_TYPES: ReadonlySet<string> = new Set(ActionSchema.options.map((o) => o.shape.type.value));
/** An ignored action in words (« verdict forcé »), its type as is when unknown. */
const skippedLabel = (t: string): string => (t === "undo" ? "annuler" : ACTION_TYPES.has(t) ? actionLabel(t as Action["type"]) : t); // oxlint-disable-line typescript/no-unsafe-type-assertion -- checked just before

function App() {
  const conn = createQuizConnection({ token });
  const view = createMemo<ControlView | null>(() => {
    const v = conn.view();
    return v !== null && v.role === "control" ? v : null;
  });
  const readonly = () => view()?.readonly === true;
  const [regrading, setRegrading] = createSignal<{ round: number; question: number } | null>(null);
  const [message, setMessage] = createSignal<{ ok: boolean; text: string } | null>(null);
  /** Last ignored-after-undo action already acknowledged (« Compris »). */
  const [seenSkipped, setSeenSkipped] = createSignal(0);
  const [links] = createResource(() => api<LinksResponse>("/api/links").catch(() => null));
  const [status, setStatus] = createSignal<StatusResponse | null>(null);
  const [now, setNow] = createSignal(conn.serverNow());
  const [tab, setTab] = createSignal<Tab>("players");
  const poll = async () => setStatus(await api<StatusResponse>("/api/status").catch(() => null));
  onMount(() => void poll());
  const timers = [setInterval(() => void poll(), 3000), setInterval(() => setNow(conn.serverNow()), 250)];
  onCleanup(() => timers.forEach(clearInterval));

  // « Envoyer au direct » from the studio: badge in the top bar + one message when it arrives.
  createEffect(
    on(
      () => { const v = view(); return v === null ? undefined : v.studioPatchedAt; }, // undefined: not connected yet
      (at, prev) => {
        if (at !== undefined && at !== null && prev !== undefined && at !== prev) setMessage({ ok: true, text: "Partie mise à jour depuis le studio : déroulé et questions à venir rafraîchis" });
      },
    ),
  );
  const act: Act = async (action, okText) => {
    const ack = await conn.submit(action);
    // A question this round cannot play: say how to get past it (never a dead end on air).
    const hint = !ack.ok && action.type === "question.present" && / ne peut pas jouer /.test(ack.reason) ? " — « Passer la question » pour la sauter" : "";
    setMessage(ack.ok ? (okText === undefined ? null : { ok: true, text: okText }) : { ok: false, text: `${ack.reason}${hint}` });
    return ack.ok;
  };
  const kb = createKeyBuzzers(view, act);
  const layers = useLayers(view);

  // Keyboard (doc 08): armed buzzer keys first, then space = next step, Ctrl+Z = undo. Ignored while typing.
  const onKey = (e: KeyboardEvent) => {
    if (isDialogOpen()) return; // our dialog owns the keyboard (Entrée / Échap)
    const t = e.target;
    // Only real text entry keeps the keys (typing a name, a score…): a list, a checkbox or a button just chosen
    // must not swallow Space / Ctrl+Z (a survey's team list used to block the undo).
    const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color"].includes(t.type));
    if (typing) return;
    const undoKey = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z";
    const choiceField = t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio"));
    if (choiceField && !undoKey) {
      // A list keeps its letters / arrows / Enter, a check box its Space; Space on a list = next step.
      if (!(t instanceof HTMLSelectElement && e.code === "Space")) return;
      t.blur();
    }
    const v = view();
    if (v === null || readonly()) return;
    if (kb.handle(e)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      const n = nextStep(v);
      if (n !== null) void act(n.action);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      void act({ type: "undo" }, "Dernière action annulée");
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const programUrl = () => {
    const e = links()?.entries.find((x) => x.id === "out-program");
    return e === undefined ? null : `${e.path}&preview=1`;
  };

  return (
    <div class="c-app" data-buzzers={String(kb.armed())}>
      <header class="c-top">
        <span class="c-brand">Régie</span>
        <Show when={view()}>
          {(v) => (
            <>
              <button type="button" class="c-game-btn" title="Voir la partie en cours et en lancer une autre" onClick={() => setTab("games")}>
                <span class="c-game-label">Partie en cours</span>
                <span class="c-game-title">{v().game.title}</span>
                <span class="c-game-meta q-mono">{v().participants.length}/{v().game.maxPlayers} j.</span>
                <Show when={v().studioPatchedAt}>
                  {(at) => <span class="c-game-edited" title="La partie a été modifiée depuis le studio pendant le show">modifiée {new Date(at()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>}
                </Show>
                <span class="c-game-change">Changer</span>
              </button>
              <span class="q-tally" data-on={ON_AIR_PHASES.has(v().phase) ? "air" : undefined}>{ON_AIR_PHASES.has(v().phase) ? "Antenne" : "Hors antenne"}</span>
              <span class="c-phase">{v().round?.title ?? "—"} · {PHASE_LABEL[v().phase]}</span>
            </>
          )}
        </Show>
        <span class="c-spacer" />
        <Show when={kb.armed()}>
          <button type="button" class="q-tally c-armed" data-on="armed" title="Désarmer" onClick={() => kb.setArmed(false)}>Buzzers armés</button>
        </Show>
        <Show when={readonly()}><span class="q-tally">Lecture seule</span></Show>
        <Show when={links()}>{(l) => <span class="c-code" title="Code à saisir sur /play">Code partie <b class="q-mono">{l().joinCode}</b></span>}</Show>
        <Show when={view()}>
          {(v) => (
            <button type="button" class="q-switch" role="switch" aria-checked={v().hostDrives} disabled={readonly()} title="Laisser l'animateur présenter, ouvrir, révéler et passer les questions depuis sa tablette" onClick={() => void act({ type: "host.setDrive", enabled: !v().hostDrives }, v().hostDrives ? "La régie reprend le pilotage" : "L'animateur pilote le déroulé")}>
              L'animateur pilote
            </button>
          )}
        </Show>
        <StatusPill status={conn.status()} queued={conn.queued()} detail={conn.statusDetail()} />
        <HomeLink />
      </header>
      <StandbyBar />

      <Show when={view()} fallback={<p class="c-wait">Connexion à la régie…</p>}>
        {(v) => {
          const regradeTarget = () => {
            const r = regrading();
            return r === null ? null : questionAt(v().rundown, { roundIndex: r.round, questionIndex: r.question });
          };
          const checks = createMemo(() => checklist(v(), status()));
          const onAirLayers = () => layers().filter((l) => v().layers[l.id] === true).length;
          return (
            <div class="c-grid">
              <Rundown view={v()} readonly={readonly()} act={act} fixing={regrading()} onRegrade={(round, question) => { const r = regrading(); setRegrading(r !== null && r.round === round && r.question === question ? null : { round, question }); }} />

              <main class="c-center">
                <Transport view={v()} readonly={readonly()} now={now()} act={act} />
                {/* Always there, fixed height: a message appearing never moves the keys and the question below. */}
                <p class={`c-message c-message-slot ${message()?.ok === false ? "c-err" : "c-ok"}`} role="status" title={message()?.text ?? ""}>{message()?.text ?? ""}</p>
                {/* Undo replays what came after: some of it may no longer apply (a verdict on an answer that is gone…). Said in words, with the list, until « Compris ». */}
                <Show when={v().skipped.filter((x) => x.seq > seenSkipped()).length > 0}>
                  <div class="c-skipped" role="status">
                    <p>
                      <b>Annulation faite.</b> {v().skipped.filter((x) => x.seq > seenSkipped()).length === 1 ? "Une action faite après ne pouvait plus s'appliquer : elle est ignorée." : `${v().skipped.filter((x) => x.seq > seenSkipped()).length} actions faites après ne pouvaient plus s'appliquer : elles sont ignorées.`}
                      <Button kind="ghost" onClick={() => setSeenSkipped(Math.max(...v().skipped.map((x) => x.seq)))}>Compris</Button>
                    </p>
                    <ul>
                      <For each={v().skipped.filter((x) => x.seq > seenSkipped())}>{(x) => <li>« {skippedLabel(x.type)} » : {x.reason}</li>}</For>
                    </ul>
                  </div>
                </Show>
                <Show when={regradeTarget()}>
                  {(q) => (
                    <section class="c-card c-fix-card">
                      <div class="c-fix-head">
                        <h2 class="q-panel-title">Corriger la réponse · {v().rundown[regrading()?.round ?? 0]?.title} · Q{(regrading()?.question ?? 0) + 1}</h2>
                        <Button kind="ghost" onClick={() => setRegrading(null)}>Fermer</Button>
                      </div>
                      <p class="c-fix-note">
                        {v().question === null || v().question?.id === q().id
                          ? "Correction en coulisse : rien ne change à l'écran, seuls les points de cette question sont recalculés."
                          : `Correction en coulisse : « ${v().question?.prompt.text ?? ""} » reste à l'antenne, seuls les points de la question ci-dessous sont recalculés.`}
                      </p>
                      <Show when={q().id} keyed>{(_id: string) => <RegradeEditor question={q()} act={act} withToken={withToken} onClose={() => setRegrading(null)} />}</Show>
                      <Show when={regrading()}>{(r) => <PastVerdicts round={r().round} question={r().question} pointsKey={`${v().ledger.length}:${v().ledger.filter((e) => e.voided).length}`} act={act} withToken={withToken} />}</Show>
                    </section>
                  )}
                </Show>
                <OnAir view={v()} readonly={readonly()} act={act} mediaUrl={conn.mediaUrl} />
              </main>

              <aside class="c-side">
                <div class="c-monitor">
                  <Show when={programUrl()} fallback={<div class="c-preview c-preview-off">Aperçu indisponible</div>}>{(u) => <ProgramPreview src={u()} />}</Show>
                </div>
                <div class="q-tabs" role="tablist">
                  <TabKey id="games" tab={tab()} setTab={setTab} label="Parties" badge={null} />
                  <TabKey id="players" tab={tab()} setTab={setTab} label="Joueurs" badge={String(v().participants.length)} />
                  <TabKey id="layers" tab={tab()} setTab={setTab} label="Couches" badge={onAirLayers() > 0 ? `${onAirLayers()} ant.` : null} tone="air" />
                  <TabKey id="tools" tab={tab()} setTab={setTab} label="Outils" badge={null} />
                  <TabKey id="check" tab={tab()} setTab={setTab} label="Check-list" badge={`${checks().filter((c) => c.ok).length}/${checks().length}`} tone={checks().every((c) => c.ok) ? "ok" : "warn"} />
                </div>
                <div class="c-tabpanel" role="tabpanel">
                  <Show when={tab() === "games"}>
                    <GamesTab view={v()} readonly={readonly()} />
                  </Show>
                  <Show when={tab() === "players"}>
                    <Players view={v()} readonly={readonly()} act={act} connected={new Set(status()?.presence?.seats ?? [])} connectedPlayers={new Set(status()?.presence?.players ?? [])} />
                    <Show when={!readonly()}>
                      <h3 class="q-panel-title c-subtitle">Équipes</h3>
                      <TeamsPanel view={v()} act={act} />
                    </Show>
                  </Show>
                  <Show when={tab() === "layers"}>
                    <Show when={!readonly()} fallback={<p class="muted">Poste en lecture seule.</p>}><LayersPanel view={v()} layers={layers()} act={act} /></Show>
                  </Show>
                  <Show when={tab() === "tools"}>
                    <div class="c-tools">
                      <Tool title="Historique des points"><LedgerPanel view={v()} readonly={readonly()} act={act} /></Tool>
                      <Tool title="Résultats (CSV, PDF)"><ResultsPanel withToken={withToken} /></Tool>
                      <Show when={!readonly()}>
                        <Tool title="Buzzers clavier (USB)"><KeyBuzzersPanel kb={kb} view={v()} /></Tool>
                        <Tool title="Chat Twitch / YouTube"><ChatPanel withToken={withToken} /></Tool>
                        <Tool title="Répétition (bots)"><RehearsalPanel withToken={withToken} /></Tool>
                        <Tool title="Code équipe (accueil)"><StaffCode withToken={withToken} /></Tool>
                        <Tool title="API de contrôle (Companion, OSC)"><ApiInfo origin={lanOrigin(links())} token={token} /></Tool>
                      </Show>
                      <Tool title="Liens OBS, vMix, tablettes"><Show when={links()} fallback={<p class="muted">…</p>}>{(l) => <LinksList links={l()} />}</Show></Tool>
                    </div>
                  </Show>
                  <Show when={tab() === "check"}>
                    <ul class="c-check">
                      <For each={checks()}>{(c) => <li data-ok={String(c.ok)}><span class="c-check-mark">{c.ok ? "✓" : "✗"}</span><span><b>{c.label}</b><br /><span class="muted">{c.detail}</span></span></li>}</For>
                    </ul>
                  </Show>
                </div>
              </aside>
            </div>
          );
        }}
      </Show>
    </div>
  );
}

/** « Parties » tab: what is live (and who may play), then every game of the studio with « Lancer ». */
function GamesTab(p: { readonly view: ControlView; readonly readonly: boolean }): JSX.Element {
  const g = () => p.view.game;
  const full = () => p.view.participants.length >= g().maxPlayers;
  return (
    <div class="c-stack">
      <section class="c-live-game">
        <span class="c-game-label">En cours sur tous les écrans</span>
        <h3 class="c-live-title">{g().title}</h3>
        <p class="muted">
          {g().rounds} manche{g().rounds > 1 ? "s" : ""} · {p.view.teams.length > 0 ? `${p.view.teams.length} équipe${p.view.teams.length > 1 ? "s" : ""}` : "joueurs individuels"} ·{" "}
          <span class="q-mono" classList={{ "c-full": full() }}>{p.view.participants.length} / {g().maxPlayers} joueur{g().maxPlayers > 1 ? "s" : ""}</span>
        </p>
        <Show when={full()}><p class="c-warn-line">Partie complète : plus aucun joueur ni siège ne peut rejoindre. Lancer une autre partie, ou augmenter le maximum dans le studio (onglet Format).</p></Show>
      </section>
      <Show when={!p.readonly} fallback={<p class="muted">Poste en lecture seule : changer de partie depuis la régie.</p>}>
        <h3 class="q-panel-title c-subtitle">Lancer une autre partie</h3>
        <p class="muted c-small">Les parties créées dans le studio. Lancer bascule régie, sorties, animateur et tablettes ; la partie en cours reste dans le journal.</p>
        <LibraryPanel current={g().title} />
        <h3 class="q-panel-title c-subtitle">Partie express (coller un CSV)</h3>
        <GameImport />
      </Show>
    </div>
  );
}

function TabKey(p: { readonly id: Tab; readonly tab: Tab; readonly setTab: (t: Tab) => void; readonly label: string; readonly badge: string | null; readonly tone?: "air" | "warn" | "ok" }): JSX.Element {
  return (
    <button type="button" role="tab" class="q-tab" aria-selected={p.tab === p.id} onClick={() => p.setTab(p.id)}>
      {p.label}
      <Show when={p.badge}>{(b) => <span class="q-tab-badge" data-tone={p.tone}>{b()}</span>}</Show>
    </button>
  );
}

/** One tool of the « Outils » tab; opening one closes the others (exclusive accordion). */
function Tool(p: { readonly title: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <details class="c-tool" name="c-tools">
      <summary>{p.title}</summary>
      <div class="c-tool-body">{p.children}</div>
    </details>
  );
}

/** The ONE next-step key (space bar), the clock and the few keys of the moment. */
function Transport(p: { readonly view: ControlView; readonly readonly: boolean; readonly now: number; readonly act: Act }): JSX.Element {
  const step = () => nextStep(p.view);
  const remaining = () => (p.view.timer === null ? null : secondsLeft(p.view.timer.endsAt, p.now));
  const answered = () => {
    const m = p.view.mechanic;
    return m !== null && "answeredCount" in m ? m.answeredCount : null;
  };
  const inQuestion = () => p.view.question !== null && p.view.phase !== "revealed" && ON_AIR_PHASES.has(p.view.phase);
  return (
    <section class="c-transport">
      <Show when={!p.readonly} fallback={<p class="muted c-grow">Poste en lecture seule : la régie maître pilote.</p>}>
        <Show when={step()} fallback={<button type="button" class="c-next" disabled>Partie terminée</button>}>
          {(n) => (
            <button type="button" class="c-next" title="Espace" onClick={() => void p.act(n().action)}>
              <span>{n().label}</span>
              <kbd>Espace</kbd>
            </button>
          )}
        </Show>
      </Show>
      <div class="c-clock" data-low={String((remaining() ?? 99) <= 5)}>
        <span class="c-clock-time q-mono" data-idle={String(remaining() === null)}>{remaining() === null ? "–:––" : `${Math.floor((remaining() ?? 0) / 60)}:${String((remaining() ?? 0) % 60).padStart(2, "0")}`}</span>
        <span class="c-clock-meta q-mono">{answered() === null ? " " : `${answered()}/${p.view.participants.length} rép.`}</span>
      </div>
      <Show when={!p.readonly}>
        <div class="c-keys">
          <Button kind="secondary" disabled={p.view.phase !== "open"} onClick={() => void p.act({ type: "timer.set", remainingMs: Math.max(0, (p.view.timer?.endsAt ?? p.now) - p.now) + 10_000 })}>+10 s</Button>
          <Button kind="secondary" disabled={p.view.phase !== "open" || p.view.timer === null} onClick={() => void p.act({ type: "timer.stop" })}>Stop chrono</Button>
          <Show
            when={!inQuestion() && p.view.phase === "idle" && p.view.round !== null}
            fallback={<Button kind="secondary" disabled={!inQuestion()} onClick={() => void confirmDialog({ title: "Passer cette question sans la révéler ?", message: "Aucun point n'est attribué pour cette question.", confirm: "Passer la question", danger: true }).then((ok) => ok && p.act({ type: "question.next" }, "Question passée"))}>Passer la question</Button>}
          >
            <Button kind="secondary" title="Sauter la question suivante sans la jouer (par exemple si elle ne peut pas être jouée dans cette manche)" onClick={() => void confirmDialog({ title: "Passer la question suivante sans la jouer ?", message: p.view.nextQuestion === null ? "Elle n'est pas présentée et ne rapporte aucun point." : `« ${p.view.nextQuestion.text} » n'est pas présentée et ne rapporte aucun point. On passe à celle d'après.`, confirm: "Passer la question", danger: true }).then((ok) => { const t = nextTarget(p.view); return ok && t !== null && p.act({ type: "question.skip", ...t }, "Question passée : la suivante est prête"); })}>Passer la question</Button>
          </Show>
          <Button kind="ghost" title="Ctrl+Z" onClick={() => void p.act({ type: "undo" }, "Dernière action annulée")}>↶ Annuler</Button>
        </div>
        <StakesBar class="c-stakes" view={p.view} act={(a, label) => p.act(a, label)} />
      </Show>
    </section>
  );
}

/** The question on air (with its mechanic controls), else the one coming next — answer and notes included. */
function OnAir(p: { readonly view: ControlView; readonly readonly: boolean; readonly act: Act; readonly mediaUrl: (h: string) => string }): JSX.Element {
  const mode = () => (p.readonly ? "host" : "control");
  const upNext = () => {
    const t = nextTarget(p.view);
    return t === null ? null : { t, q: questionAt(p.view.rundown, t), r: p.view.rundown[t.roundIndex] };
  };
  return (
    <>
    <Show
      when={p.view.question}
      fallback={
        <>
          <Show when={p.view.mechanic !== null}>
            <section class="c-card"><MechanicPanel view={p.view} mode={mode()} act={p.act} mediaUrl={p.mediaUrl} /></section>
          </Show>
          <Show when={upNext()?.q} fallback={<Show when={p.view.mechanic === null}><section class="c-card c-card-empty"><p class="muted">{p.view.phase === "game.end" ? "Partie terminée." : "Rien à l'antenne."}</p></section></Show>}>
            {(q) => (
              <section class="c-card" data-mode="next">
                <div class="c-card-head">
                  <span class="q-tally" data-on="next">Suivante</span>
                  <span class="muted">{upNext()?.r?.title} · <span class="q-mono">Q{q().index + 1}/{upNext()?.r?.questions.length}</span></span>
                </div>
                <p class="c-prompt">{q().text}</p>
                <p class="c-answer"><span class="q-label">Réponse</span> {formatAnswer(q().answerSpec).headline}</p>
                <Show when={q().points.summary}><p class="c-worth" title={q().points.why}><span class="q-label">Vaut</span> <Show when={p.view.stakes?.worth} fallback={<>{q().points.summary} <span class="muted">· {q().points.why}</span></>}>{(w) => <><b class="c-worth-staked">{w()}</b> <span class="muted">· avec la mise (sans : {q().points.summary}, {q().points.why})</span></>}</Show></p></Show>
                <Show when={q().notes}>{(n) => <p class="c-notes">{n()}</p>}</Show>
              </section>
            )}
          </Show>
        </>
      }
    >
      {(q) => (
        <section class="c-card" data-mode="air">
          <div class="c-card-head">
            <span class="q-tally" data-on="air">À l'antenne</span>
            <span class="muted">{p.view.round?.title} · <span class="q-mono">Q{q().index + 1}/{q().count}</span></span>
            <span class="c-spacer" />
            <Show when={!p.readonly}><QuestionTextEdit text={q().prompt.text} act={p.act} /></Show>
          </div>
          <p class="c-prompt">{q().prompt.text}</p>
          <Show when={(() => { const t = onAirTarget(p.view); return t === null ? undefined : questionAt(p.view.rundown, t)?.points; })()}>
            {(pt) => <Show when={pt().summary}><p class="c-worth" title="Priorité des points : la question, sinon sa catégorie, sinon la manche ; la mise (en haut) s'applique par-dessus"><span class="q-label">Vaut</span> <Show when={p.view.stakes?.worth} fallback={<>{pt().summary} <span class="muted">· {pt().why}</span></>}>{(w) => <><b class="c-worth-staked">{w()}</b> <span class="muted">· avec la mise (sans : {pt().summary}, {pt().why})</span></>}</Show></p></Show>}
          </Show>
          <Show when={asChoice(p.view.mechanic)}>
            {(m) => (
              <ul class="c-opts">
                <For each={m().options}>
                  {(o, i) => (
                    <li class="c-opt" data-correct={String(m().correct?.includes(o.id) === true)}>
                      <span class="c-opt-letter q-mono">{optionLetter(i())}</span>
                      <span class="c-grow">{o.label}</span>
                      <span class="c-count q-mono">{m().counts?.[o.id] ?? ""}</span>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
          <MechanicPanel view={p.view} mode={mode()} act={p.act} mediaUrl={p.mediaUrl} />
          <VerdictsPanel view={p.view} readonly={p.readonly} act={p.act} />
          <Show when={p.view.notes}>{(n) => <p class="c-notes">{n()}</p>}</Show>
        </section>
      )}
    </Show>
    <Show when={p.view.question !== null ? upNext()?.q : null}>{(q) => <p class="c-then"><span class="q-label">Ensuite</span><span>{q().text}</span></p>}</Show>
    </>
  );
}

/** Left column: rounds (collapsible), questions with their state; a click presents one when idle in its round. */
function Rundown(p: { readonly view: ControlView; readonly readonly: boolean; readonly act: Act; readonly fixing: { round: number; question: number } | null; readonly onRegrade: (round: number, question: number) => void }): JSX.Element {
  const [toggled, setToggled] = createSignal<ReadonlySet<number>>(new Set());
  const air = () => onAirTarget(p.view);
  const next = () => nextTarget(p.view);
  const isOpen = (i: number) => (p.view.round?.index ?? 0) === i ? !toggled().has(i) : toggled().has(i);
  const toggle = (i: number) => {
    const s = new Set(toggled());
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setToggled(s);
  };
  return (
    <nav class="c-rundown" aria-label="Déroulé">
      <h2 class="q-panel-title">Déroulé</h2>
      <For each={p.view.rundown}>
        {(r) => (
          <section class="c-round" data-current={String(p.view.round?.index === r.index)}>
            <div class="c-round-head">
              <button type="button" class="c-round-toggle" aria-expanded={isOpen(r.index)} onClick={() => toggle(r.index)}>
                <span class="c-round-title">{r.title}</span>
                <span class="c-round-meta q-mono">{MECHANIC_LABEL[r.mechanic] ?? r.mechanic} · {r.questions.filter((q) => q.played).length}/{r.questions.length}</span>
              </button>
              <Show when={!p.readonly && (p.view.phase === "idle" || p.view.phase === "round.end") && p.view.round?.index !== r.index}>
                <Button kind="ghost" onClick={() => void p.act({ type: "round.start", roundIndex: r.index })}>Démarrer</Button>
              </Show>
            </div>
            <Show when={isOpen(r.index)}>
              <For each={r.questions}>
                {(q) => {
                  const t = { roundIndex: r.index, questionIndex: q.index };
                  const state = () => (sameTarget(t, air()) ? "air" : sameTarget(t, next()) ? "next" : q.played ? "played" : "todo");
                  const why = () =>
                    p.readonly ? "Poste en lecture seule"
                    : p.view.round?.index !== r.index ? "Démarrer cette manche pour choisir ses questions"
                    : p.view.phase !== "idle" ? "Une question est en cours : la révéler puis « Suivante » (ou « Passer la question ») avant d'en choisir une autre"
                    : null;
                  const present = async () => {
                    // A played question is only replayed on purpose (its points are given again).
                    if (q.played && !(await confirmDialog({ title: `Rejouer la question ${q.index + 1} ?`, message: `« ${q.text} » a déjà été jouée : elle repasse à l'antenne et ses points seront attribués une nouvelle fois. Pour changer sa réponse sans la rejouer : « Corriger ».`, confirm: "Rejouer à l'antenne", danger: true }))) return;
                    await p.act({ type: "question.present", questionIndex: q.index });
                  };
                  const fixingThis = () => p.fixing !== null && p.fixing.round === r.index && p.fixing.question === q.index;
                  return (
                    <div class="c-q-row" data-fixing={String(fixingThis())}>
                      <button type="button" class="c-q" data-state={state()} data-current={String(state() === "air")} data-played={String(q.played)} title={why() ?? `${q.text}${q.points.summary === "" ? "" : ` — vaut ${q.points.summary} (${q.points.why})`} — ${q.played ? "déjà jouée : cliquer pour la rejouer" : "cliquer pour la présenter"}`} disabled={why() !== null} onClick={() => void present()}>
                        <span class="c-q-n q-mono">{q.index + 1}</span>
                        <span class="c-q-t">{q.text}</span>
                        <Show when={q.played}><span class="c-q-ok">✓</span></Show>
                      </button>
                      <Show when={q.played && !p.readonly}>
                        <button type="button" class="c-q-fix" aria-pressed={fixingThis()} title="Corriger la réponse et recalculer les points (sans rien changer à l'écran)" onClick={() => p.onRegrade(r.index, q.index)}>{fixingThis() ? "Fermer" : "Corriger"}</button>
                      </Show>
                    </div>
                  );
                }}
              </For>
              <ReserveList view={p.view} round={r} readonly={p.readonly} act={p.act} />
            </Show>
          </section>
        )}
      </For>
    </nav>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
