import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { Action, ControlView, Participant } from "@quiz/schema";
import { optionLetter, secondsLeft } from "@quiz/renderer";
import { Button, Panel, StatusPill, createQuizConnection, tokenFromUrl } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./control.css";
import { checklist, nextStep, parsePlayersCsv } from "./logic.ts";

type LinksResponse = { origins: string[]; entries: { label: string; id: string; path: string }[]; joinCode: string };
type StatusResponse = { journal?: { ok?: boolean; journalMode?: unknown; synchronous?: unknown; lastError?: string | null }; presence?: { total: number; byRole: Record<string, number>; seats: number[]; players: string[] } };

const token = tokenFromUrl();
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoints
};

const hex = (n: number): string => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b); // works over plain HTTP (ADR-0012)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

function App() {
  const conn = createQuizConnection({ token });
  const view = createMemo<ControlView | null>(() => {
    const v = conn.view();
    return v !== null && v.role === "control" ? v : null;
  });
  const readonly = () => view()?.readonly === true;
  const [message, setMessage] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [links] = createResource(() => api<LinksResponse>("/api/links").catch(() => null));
  const [status, setStatus] = createSignal<StatusResponse | null>(null);
  const [now, setNow] = createSignal(conn.serverNow());
  const poll = async () => setStatus(await api<StatusResponse>("/api/status").catch(() => null));
  onMount(() => void poll());
  const timers = [setInterval(() => void poll(), 3000), setInterval(() => setNow(conn.serverNow()), 250)];
  onCleanup(() => timers.forEach(clearInterval));

  const act = async (action: Action, okText?: string) => {
    const ack = await conn.submit(action);
    setMessage(ack.ok ? (okText === undefined ? null : { ok: true, text: okText }) : { ok: false, text: ack.reason });
    return ack.ok;
  };

  // Keyboard (doc 08): space = next step, Ctrl+Z = undo. Ignored while typing in a field.
  const onKey = (e: KeyboardEvent) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    const v = view();
    if (v === null || readonly()) return;
    if (e.code === "Space") {
      e.preventDefault();
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
    const l = links();
    const e = l?.entries.find((x) => x.id === "out-program");
    return e === undefined ? null : `${e.path}&preview=1`;
  };

  return (
    <div class="c-app">
      <header class="c-top">
        <h1>Régie</h1>
        <Show when={view()}>{(v) => <span class="muted">{v().round?.title ?? "—"} · {PHASE_LABEL[v().phase]}</span>}</Show>
        <span class="c-spacer" />
        <Show when={links()}>{(l) => <span class="c-code" title="Code pour /play">Code partie : <b>{l().joinCode}</b></span>}</Show>
        <StatusPill status={conn.status()} queued={conn.queued()} detail={conn.statusDetail()} />
      </header>
      <Show when={view()} fallback={<p class="c-wait">Connexion à la régie…</p>}>
        {(v) => (
          <div class="c-grid">
            <Panel title="Déroulé" class="c-rundown">
              <For each={v().rundown}>
                {(r) => (
                  <div class="c-round">
                    <div class="c-round-head">
                      <b>{r.title}</b>
                      <Show when={!readonly() && (v().phase === "idle" || v().phase === "round.end") && v().round?.index !== r.index}>
                        <Button kind="ghost" onClick={() => void act({ type: "round.start", roundIndex: r.index })}>Démarrer</Button>
                      </Show>
                    </div>
                    <For each={r.questions}>
                      {(q) => {
                        const current = () => v().round?.index === r.index && v().question?.index === q.index;
                        return (
                          <button type="button" class="c-q" data-current={String(current())} data-played={String(q.played)} disabled={readonly() || v().phase !== "idle" || v().round?.index !== r.index} onClick={() => void act({ type: "question.present", questionIndex: q.index })}>
                            <span class="c-q-n">{q.index + 1}</span>
                            <span class="c-q-t">{q.text}</span>
                            <Show when={q.played}><span class="c-q-ok">✓</span></Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Panel>

            <div class="c-center">
              <Panel title="Programme (ce qui part à l'antenne)">
                <Show when={programUrl()} fallback={<span class="muted">Aperçu indisponible</span>}>{(u) => <ProgramPreview src={u()} />}</Show>
              </Panel>
              <Panel title="Question en cours">
                <Show when={v().question} fallback={<p class="muted">Aucune question à l'écran.</p>}>
                  {(q) => (
                    <div class="c-current">
                      <p class="c-prompt">{q().prompt.text}</p>
                      <Show when={v().mechanic?.mechanic === "choice" ? v().mechanic : null}>
                        {(mm) => {
                          const m = () => (mm().mechanic === "choice" ? mm() : null);
                          return (
                            <div class="c-opts">
                              <For each={m()?.options ?? []}>
                                {(o, i) => (
                                  <div class="c-opt" data-correct={String(m()?.correct?.includes(o.id) === true)}>
                                    <span>{optionLetter(i())}</span> {o.label}
                                    <span class="c-count">{m()?.counts?.[o.id] ?? ""}</span>
                                  </div>
                                )}
                              </For>
                              <p class="muted">{m()?.answeredCount ?? 0} réponse(s) · {v().participants.length} joueur(s)</p>
                            </div>
                          );
                        }}
                      </Show>
                      <Show when={v().notes}>{(n) => <p class="c-notes">📝 {n()}</p>}</Show>
                    </div>
                  )}
                </Show>
              </Panel>
            </div>

            <div class="c-right">
              <Panel title="Actions">
                <Show when={!readonly()} fallback={<p class="muted">Poste en lecture seule.</p>}>
                  <Show when={nextStep(v())} fallback={<p class="muted">Partie terminée.</p>}>
                    {(n) => (
                      <Button big onClick={() => void act(n().action)} title="Espace">
                        {n().label} ▶
                      </Button>
                    )}
                  </Show>
                  <div class="c-row">
                    <Show when={v().timer}>{(t) => <span class="c-timer">⏱ {secondsLeft(t().endsAt, now())} s</span>}</Show>
                    <Show when={v().phase === "open"}>
                      <Button kind="secondary" onClick={() => void act({ type: "timer.set", remainingMs: Math.max(0, (v().timer?.endsAt ?? now()) - now()) + 10_000 })}>+10 s</Button>
                      <Button kind="secondary" onClick={() => void act({ type: "timer.stop" })}>Stop chrono</Button>
                    </Show>
                  </div>
                  <div class="c-row">
                    <Button kind="secondary" title="Ctrl+Z" onClick={() => void act({ type: "undo" }, "Dernière action annulée")}>↶ Annuler</Button>
                    <Show when={v().question !== null && v().phase !== "revealed"}>
                      <Button kind="ghost" onClick={() => void act({ type: "question.next" }, "Question passée")}>Passer la question</Button>
                    </Show>
                  </div>
                  <p class="muted c-keys"><kbd>Espace</kbd> étape suivante · <kbd>Ctrl</kbd>+<kbd>Z</kbd> annuler</p>
                </Show>
                <Show when={message()}>{(m) => <p class={m().ok ? "c-ok" : "c-err"}>{m().text}</p>}</Show>
                <Show when={v().skipped.length > 0}>
                  <p class="c-err">{v().skipped.length} action(s) devenue(s) sans effet après un undo.</p>
                </Show>
              </Panel>
              <Panel title="Prêt pour l'antenne">
                <ul class="c-check">
                  <For each={checklist(v(), status())}>{(c) => <li data-ok={String(c.ok)}><span>{c.ok ? "✓" : "✗"}</span> {c.label} <span class="muted">— {c.detail}</span></li>}</For>
                </ul>
              </Panel>
              <Panel title="Liens (OBS / vMix / tablettes)">
                <Show when={links()} fallback={<p class="muted">…</p>}>{(l) => <LinksList links={l()} />}</Show>
              </Panel>
            </div>

            <Panel title="Joueurs et scores" class="c-players">
              <Players view={v()} readonly={readonly()} act={act} connected={new Set(status()?.presence?.seats ?? [])} connectedPlayers={new Set(status()?.presence?.players ?? [])} />
            </Panel>
          </div>
        )}
      </Show>
    </div>
  );
}

const PHASE_LABEL: Record<ControlView["phase"], string> = {
  lobby: "avant la partie",
  idle: "entre deux questions",
  presenting: "question présentée",
  open: "réponses ouvertes",
  locked: "réponses fermées",
  judging: "validation",
  revealed: "réponse révélée",
  "round.end": "fin de manche",
  "game.end": "fin de partie",
};

/** The real program output, embedded and scaled: exactly what goes on air (same page OBS loads). */
function ProgramPreview(p: { src: string }) {
  let box: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(0.4);
  onMount(() => {
    if (box === undefined) return;
    const el = box;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1920));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div ref={box} class="c-preview" style={{ "--s": String(scale()) }}>
      <iframe title="programme" src={p.src} />
    </div>
  );
}

function LinksList(p: { links: LinksResponse }) {
  const [origin, setOrigin] = createSignal(p.links.origins.find((o) => !o.includes("localhost")) ?? p.links.origins[0] ?? location.origin);
  const [copied, setCopied] = createSignal<string | null>(null);
  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text); // may be unavailable over HTTP: fall back to selection
      setCopied(id);
    } catch {
      window.prompt("Copier le lien :", text); // oxlint-disable-line no-alert -- clipboard API needs a secure context; manual copy fallback
    }
  };
  return (
    <div class="c-links">
      <label class="muted">
        Adresse du serveur vue par les autres PC :{" "}
        <select value={origin()} onChange={(e) => setOrigin(e.currentTarget.value)}>
          <For each={p.links.origins}>{(o) => <option value={o}>{o}</option>}</For>
        </select>
      </label>
      <p class="muted">Joueurs : {origin()}/play — code <b>{p.links.joinCode}</b></p>
      <For each={p.links.entries.filter((e) => !e.id.startsWith("seat-") || Number(e.id.slice(5)) <= 8)}>
        {(e) => (
          <div class="c-link">
            <span>{e.label}</span>
            <Button kind="secondary" onClick={() => void copy(`${origin()}${e.path}`, e.id)}>{copied() === e.id ? "Copié ✓" : "Copier"}</Button>
          </div>
        )}
      </For>
      <p class="muted">Liste complète (tous les sièges) : links.txt dans le dossier de données du serveur.</p>
    </div>
  );
}

function Players(p: { view: ControlView; readonly: boolean; act: (a: Action, ok?: string) => Promise<boolean>; connected: Set<number>; connectedPlayers: Set<string> }) {
  const [name, setName] = createSignal("");
  const [csv, setCsv] = createSignal("");
  const [csvReport, setCsvReport] = createSignal<string | null>(null);
  const totals = createMemo(() => new Map(p.view.leaderboard.map((r) => [r.participantId, r])));
  const freeSeat = () => {
    const used = new Set(p.view.participants.map((x) => x.seat));
    for (let i = 1; i < 999; i++) if (!used.has(i)) return i;
    return undefined;
  };
  const add = async () => {
    const n = name().trim();
    if (n.length === 0) return;
    const seat = freeSeat();
    if (await p.act({ type: "player.add", participantId: `p_${hex(8)}`, displayName: n, channel: "seat", ...(seat === undefined ? {} : { seat }) })) setName("");
  };
  const importCsv = async () => {
    const { rows, errors } = parsePlayersCsv(csv());
    const teams = new Map(p.view.teams.map((t) => [t.name.toLowerCase(), t.id]));
    let ok = 0;
    const failures = [...errors];
    for (const r of rows) {
      let teamId: string | undefined;
      if (r.team !== null) {
        teamId = teams.get(r.team.toLowerCase());
        if (teamId === undefined) {
          teamId = `t_${hex(6)}`;
          if (await p.act({ type: "team.add", teamId, name: r.team, color: `#${hex(3)}` })) teams.set(r.team.toLowerCase(), teamId);
        }
      }
      const added = await p.act({ type: "player.add", participantId: `p_${hex(8)}`, displayName: r.name, channel: "seat", ...(r.seat === null ? {} : { seat: r.seat }), ...(teamId === undefined ? {} : { teamId }) });
      if (added) ok++;
      else failures.push(`${r.name} : refusé`);
    }
    setCsvReport(`${ok} joueur(s) importé(s)${failures.length > 0 ? ` · ${failures.length} problème(s) : ${failures.join(" · ")}` : ""}`);
    if (failures.length === 0) setCsv("");
  };
  const online = (pl: Participant) => (pl.seat !== null && p.connected.has(pl.seat)) || p.connectedPlayers.has(pl.id);
  return (
    <div class="c-players-inner">
      <table>
        <thead>
          <tr><th>#</th><th>Joueur</th><th>Siège</th><th>Équipe</th><th>Statut</th><th>Score</th><th /></tr>
        </thead>
        <tbody>
          <For each={p.view.participants}>
            {(pl) => (
              <tr data-status={pl.status}>
                <td>{totals().get(pl.id)?.rank ?? "–"}</td>
                <td>
                  <span class={`c-dot ${online(pl) ? "c-dot-on" : ""}`} title={online(pl) ? "tablette connectée" : "non connectée"} />
                  <input value={pl.displayName} disabled={p.readonly} onChange={(e) => void p.act({ type: "player.rename", participantId: pl.id, displayName: e.currentTarget.value })} />
                </td>
                <td>
                  <input class="c-num" type="number" min="1" value={pl.seat ?? ""} disabled={p.readonly} onChange={(e) => void p.act({ type: "player.setSeat", participantId: pl.id, seat: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })} />
                </td>
                <td>
                  <select value={pl.teamId ?? ""} disabled={p.readonly} onChange={(e) => void p.act({ type: "player.setTeam", participantId: pl.id, teamId: e.currentTarget.value === "" ? null : e.currentTarget.value })}>
                    <option value="">—</option>
                    <For each={p.view.teams}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                  </select>
                </td>
                <td>
                  <select value={pl.status} disabled={p.readonly} onChange={(e) => void p.act({ type: "player.setStatus", participantId: pl.id, status: e.currentTarget.value as Participant["status"] })}> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- options below are exactly the enum */}
                    <option value="active">actif</option>
                    <option value="eliminated">éliminé</option>
                    <option value="waiting">en attente</option>
                    <option value="substitute">remplaçant</option>
                    <option value="disconnected">absent</option>
                  </select>
                </td>
                <td class="c-score">
                  <Button kind="secondary" disabled={p.readonly} onClick={() => void p.act({ type: "score.adjust", target: { participantId: pl.id }, delta: -10, reason: "penalty" })}>−10</Button>
                  <input class="c-num" type="number" value={totals().get(pl.id)?.total ?? 0} disabled={p.readonly} onChange={(e) => void p.act({ type: "score.setTotal", target: { participantId: pl.id }, total: Math.round(Number(e.currentTarget.value)) })} />
                  <Button kind="secondary" disabled={p.readonly} onClick={() => void p.act({ type: "score.adjust", target: { participantId: pl.id }, delta: 10, reason: "bonus" })}>+10</Button>
                </td>
                <td>
                  <Button kind="ghost" disabled={p.readonly} onClick={() => { if (window.confirm(`Retirer ${pl.displayName} ?`)) void p.act({ type: "player.remove", participantId: pl.id }); }}>Retirer</Button> {/* oxlint-disable-line no-alert -- irreversible action confirmation (doc 08) */}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={!p.readonly}>
        <div class="c-add">
          <input placeholder="Nouveau joueur" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          <Button onClick={() => void add()}>Ajouter</Button>
        </div>
        <details class="c-csv">
          <summary>Importer des joueurs (coller depuis Excel / CSV : nom ; siège ; équipe)</summary>
          <textarea rows={6} value={csv()} onInput={(e) => setCsv(e.currentTarget.value)} placeholder={"Ana;1;Rouges\nBo;2;Bleus"} />
          <Button onClick={() => void importCsv()}>Importer</Button>
          <Show when={csvReport()}>{(r) => <p class="muted">{r()}</p>}</Show>
        </details>
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
