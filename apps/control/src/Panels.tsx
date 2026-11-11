import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { OUTPUT_SCENES, STATUS_LABEL_FR, gameFromQuestions, parseQuestionsCsv, type Action, type ControlView, type Participant, type Scene } from "@quiz/schema";
import { Button, confirmDialog } from "@quiz/ui";
import { api, hex, lanOrigin, type LinksResponse } from "./api.ts";
import { copyText } from "./Integrations.tsx";
import { layerShows, parsePlayersCsv } from "./logic.ts";

/** Right-column panels of the control room (players, layers, library, import, links). Intents or server calls only. */

type Act = (a: Action, ok?: string) => Promise<boolean>;

/** The real program output, embedded and scaled: exactly what goes on air (same page OBS loads). */
export function ProgramPreview(p: { readonly src: string }): JSX.Element {
  let box: HTMLDivElement | undefined;
  const [scale, setScale] = createSignal(0.2);
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

/** Manual / auto-hold layers of the current game's scenes (or the built-in presets). */
export function useLayers(view: () => ControlView | null) {
  const [layers] = createResource(
    () => { const v = view(); return v === null ? undefined : `${v.sessionId}:${v.gameVersion}`; },
    async () => {
      type L = Scene["layers"][number];
      const r = await api<{ scenes: Scene[] }>("/api/presentation").catch((): { scenes: Scene[] } => ({ scenes: [] }));
      const scenes: readonly Scene[] = r.scenes.length > 0 ? r.scenes : Object.values(OUTPUT_SCENES);
      const seen = new Map<string, L>();
      for (const s of scenes) for (const l of s.layers) if (l.mode !== "auto" && !seen.has(l.id)) seen.set(l.id, l);
      return [...seen.values()].map((l) => ({ id: l.id, name: l.name, zones: l.zones }));
    },
  );
  return () => layers() ?? [];
}

/** TAKE puts a layer on air, OUT takes it off. */
export function LayersPanel(p: { readonly view: ControlView; readonly layers: readonly { id: string; name: string; zones: Parameters<typeof layerShows>[0] }[]; readonly act: Act }): JSX.Element {
  return (
    <Show when={p.layers.length > 0} fallback={<p class="muted">Aucune couche manuelle dans les scènes.</p>}>
      <ul class="c-list">
        <For each={p.layers}>
          {(l) => {
            const onAir = () => p.view.layers[l.id] === true;
            return (
              <li class="c-list-row" data-air={String(onAir())}>
                <span class="c-grow">{l.name}<br /><small class="muted">Affiche {layerShows(l.zones, p.view.round?.title ?? null)}. Réglable dans le studio, onglet Scènes.</small></span>
                <Show when={onAir()}><span class="q-tally" data-on="air">Antenne</span></Show>
                <Button kind={onAir() ? "danger" : "primary"} onClick={() => void p.act(onAir() ? { type: "layer.out", layerId: l.id } : { type: "layer.take", layerId: l.id })}>{onAir() ? "OUT" : "TAKE"}</Button>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}

/** Games prepared in the studio: launch one live (screens follow, links unchanged). */
export function LibraryPanel(p: { readonly current?: string }): JSX.Element {
  const [games, { refetch }] = createResource(() => api<{ games: { id: string; title: string; questions: number; rounds: number; updatedAt: number }[] }>("/api/games").then((r) => r.games.toSorted((a, b) => b.updatedAt - a.updatedAt)).catch(() => []));
  const [msg, setMsg] = createSignal<string | null>(null);
  const [keep, setKeep] = createSignal(true);
  const launch = async (id: string, title: string) => {
    const players = keep() ? "Les joueurs restent connectés (mêmes sièges, mêmes équipes), scores remis à zéro." : "Tous les joueurs repartent de zéro : ils devront rejoindre à nouveau.";
    if (!(await confirmDialog({ title: `Lancer « ${title} » maintenant ?`, message: `Tous les écrans passent sur cette partie. ${players} La partie en cours reste dans le journal.`, confirm: "Lancer", danger: true }))) return;
    try {
      const r = await api<{ joinCode: string; kept: number; dropped: number }>(`/api/games/${id}/launch${keep() ? "" : "?players=new"}`, { method: "POST" });
      setMsg(`« ${title} » lancée · code joueurs ${r.joinCode}${keep() ? ` · ${r.kept} joueur(s) gardé(s)${r.dropped > 0 ? `, ${r.dropped} au-delà du maximum de la partie` : ""}` : ""}`);
      void refetch();
    } catch (e) {
      setMsg(`Échec : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div class="c-stack">
      <ul class="c-list">
        <For each={games() ?? []} fallback={<li class="muted">Aucune partie enregistrée dans le studio.</li>}>
          {(g) => (
            <li class="c-list-row" data-live={String(g.title === p.current)}>
              <span class="c-grow">{g.title} <span class="muted q-mono">{g.rounds} m. · {g.questions} q.</span></span>
              <Show when={g.title === p.current}><span class="c-live-tag">en cours</span></Show>
              <Button kind="secondary" onClick={() => void launch(g.id, g.title)}>{g.title === p.current ? "Relancer" : "Lancer"}</Button>
            </li>
          )}
        </For>
      </ul>
      <label class="c-keep"><input type="checkbox" checked={keep()} onChange={(e) => setKeep(e.currentTarget.checked)} /> Garder les joueurs actuels (scores remis à zéro)</label>
      <div class="c-row c-row-tight"><Button kind="ghost" onClick={() => void refetch()}>Actualiser</Button></div>
      <Show when={msg()}>{(m) => <p class="muted">{m()}</p>}</Show>
    </div>
  );
}

export function TeamsPanel(p: { readonly view: ControlView; readonly act: Act }): JSX.Element {
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal("#f0a830");
  const add = async () => {
    if (name().trim().length === 0) return;
    if (await p.act({ type: "team.add", teamId: `t_${hex(6)}`, name: name().trim(), color: color() })) setName("");
  };
  return (
    <div class="c-stack">
      <Show when={p.view.teamBoard.length > 0}>
        <ul class="c-list">
          <For each={p.view.teamBoard}>{(t) => <li class="c-list-row"><span class="c-swatch" style={{ background: t.color }} /><span class="c-grow">{t.name}</span><b class="q-mono">{t.total}</b></li>}</For>
        </ul>
      </Show>
      <div class="c-add">
        <input placeholder="Nouvelle équipe" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <input type="color" value={color()} onInput={(e) => setColor(e.currentTarget.value)} aria-label="Couleur" />
        <Button kind="secondary" onClick={() => void add()}>Ajouter</Button>
      </div>
    </div>
  );
}

const CSV_EXAMPLE = ["type;question;A;B;C;D;E;F;réponse;notes", "qcm;Capitale de l'Italie ?;Milan;Rome;Turin;;;;B;", "vf;Le soleil est une étoile.;;;;;;;vrai;"].join("\n");

/** CSV / spreadsheet paste → preview → new game. The screens follow at once, links stay the same. */
export function GameImport(): JSX.Element {
  const [title, setTitle] = createSignal("Ma partie");
  const [text, setText] = createSignal("");
  const [seconds, setSeconds] = createSignal(20);
  const [result, setResult] = createSignal<string | null>(null);
  const parsed = createMemo(() => parseQuestionsCsv(text()));
  const loadFile = async (f: File | undefined) => {
    if (f !== undefined) setText(await f.text());
  };
  const launch = async () => {
    const { questions } = parsed();
    if (questions.length === 0) return;
    if (!(await confirmDialog({ title: `Lancer « ${title()} » (${questions.length} questions) ?`, message: "Tous les écrans passent sur cette partie. La partie en cours reste dans le journal.", confirm: "Lancer", danger: true }))) return;
    try {
      const game = gameFromQuestions(title().trim() || "Partie", questions, { timerSeconds: seconds(), points: 100, maxPlayers: 1000 });
      const r = await api<{ sessionId: string; joinCode: string }>("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game }) });
      setResult(`Nouvelle partie lancée · code joueurs ${r.joinCode}`);
      setText("");
    } catch (e) {
      setResult(`Échec : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div class="c-stack">
      <div class="c-row c-row-tight">
        <label class="c-field c-grow">Titre <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
        <label class="c-field">Chrono (s) <input class="c-num" type="number" min="5" max="600" value={seconds()} onInput={(e) => setSeconds(Number(e.currentTarget.value) || 20)} /></label>
      </div>
      <textarea class="c-mono-area" rows={5} placeholder={CSV_EXAMPLE} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => void loadFile(e.currentTarget.files?.[0])} />
      <Show when={text().trim().length > 0}>
        <p class="muted">{parsed().questions.length} question(s) prête(s){parsed().errors.length > 0 ? ` · ${parsed().errors.length} ligne(s) ignorée(s)` : ""}</p>
        <Show when={parsed().errors.length > 0}>
          <ul class="c-errors"><For each={parsed().errors.slice(0, 8)}>{(e) => <li>{e}</li>}</For></ul>
        </Show>
      </Show>
      <div class="c-row c-row-tight"><Button disabled={parsed().questions.length === 0} onClick={() => void launch()}>Lancer cette partie</Button></div>
      <Show when={result()}>{(r) => <p class="muted">{r()}</p>}</Show>
    </div>
  );
}

export function LinksList(p: { readonly links: LinksResponse }): JSX.Element {
  const [origin, setOrigin] = createSignal(lanOrigin(p.links));
  const [copied, setCopied] = createSignal<string | null>(null);
  return (
    <div class="c-stack">
      <label class="c-field">
        Adresse du serveur vue par les autres PC
        <select value={origin()} onChange={(e) => setOrigin(e.currentTarget.value)}>
          <For each={p.links.origins}>{(o) => <option value={o}>{o}</option>}</For>
        </select>
      </label>
      <p class="muted">Joueurs : <span class="q-mono">{origin()}/play</span>, code <b class="q-mono">{p.links.joinCode}</b></p>
      <ul class="c-list">
        <For each={p.links.entries.filter((e) => !e.id.startsWith("seat-") || Number(e.id.slice(5)) <= 8)}>
          {(e) => (
            <li class="c-list-row">
              <span class="c-grow">{e.label}</span>
              <Button kind="secondary" onClick={() => void copyText(`${origin()}${e.path}`).then((ok) => setCopied(ok ? e.id : null))}>{copied() === e.id ? "Copié" : "Copier"}</Button>
            </li>
          )}
        </For>
      </ul>
      <p class="muted">Tous les sièges : links.txt dans le dossier de données du serveur, ou l'accueil.</p>
    </div>
  );
}

const STATUSES: readonly Participant["status"][] = ["active", "substitute", "eliminated"];
const asStatus = (v: string): Participant["status"] => STATUSES.find((s) => s === v) ?? "active";

/** Players: compact rows (online, rank, name, score ±10); a row opens to edit seat, team, status, total. */
export function Players(p: { readonly view: ControlView; readonly readonly: boolean; readonly act: Act; readonly connected: Set<number>; readonly connectedPlayers: Set<string> }): JSX.Element {
  const [name, setName] = createSignal("");
  const [csv, setCsv] = createSignal("");
  const [csvReport, setCsvReport] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  const totals = createMemo(() => new Map(p.view.leaderboard.map((r) => [r.participantId, r])));
  // Score step of the − / + keys: 1 by default, remembered on this station.
  const STEPS = [1, 5, 10, 50, 100] as const;
  const savedStep = (() => {
    try {
      const n = Number(localStorage.getItem("quiz.control.step"));
      return STEPS.find((x) => x === n) ?? 1;
    } catch {
      return 1;
    }
  })();
  const [step, setStep] = createSignal<number>(savedStep);
  const chooseStep = (n: number) => {
    setStep(n);
    try {
      localStorage.setItem("quiz.control.step", String(n));
    } catch {
      // private mode: not remembered
    }
  };
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
  const sorted = createMemo(() => p.view.participants.toSorted((a, b) => (totals().get(a.id)?.rank ?? 1e9) - (totals().get(b.id)?.rank ?? 1e9)));
  const teamOf = (id: string | null) => p.view.teams.find((t) => t.id === id) ?? null;
  return (
    <div class="c-stack">
      <Show when={!p.readonly && p.view.participants.length > 0}>
        <div class="c-steps" role="group" aria-label="Pas des boutons − / +">
          <span class="muted">Ajuster de</span>
          <For each={STEPS}>{(n) => <button type="button" class="q-stakes-key" data-on={String(step() === n)} onClick={() => chooseStep(n)}>{n}</button>}</For>
          <span class="muted">point(s) · total exact : cliquer sur le nom</span>
        </div>
      </Show>
      <ul class="c-players">
        <For each={sorted()} fallback={<li class="muted c-empty">Aucun joueur. Ajoutez-en ci-dessous ou importez une liste.</li>}>
          {(pl) => (
            <li class="c-player" data-status={pl.status} data-open={String(editing() === pl.id)}>
              <div class="c-player-row">
                <span class={`c-dot ${online(pl) ? "c-dot-on" : ""}`} title={online(pl) ? "tablette connectée" : "non connectée"} />
                <span class="c-rank q-mono">{totals().get(pl.id)?.rank ?? "–"}</span>
                <button type="button" class="c-player-name" disabled={p.readonly} title="Modifier" onClick={() => setEditing(editing() === pl.id ? null : pl.id)}>
                  <span class="c-player-label">{pl.displayName}</span>
                  <Show when={teamOf(pl.teamId)}>{(t) => <span class="c-swatch" style={{ background: t().color }} title={t().name} />}</Show>
                  <Show when={pl.seat !== null}><span class="muted q-mono" title="Tablette du pupitre">S{pl.seat}</span></Show>
                  <Show when={pl.channel === "play"}><span class="muted c-channel" title="A rejoint avec son propre appareil (code partie, /play)">son appareil</span></Show>
                  <Show when={pl.status !== "active"}><span class="c-status">{STATUS_LABEL_FR[pl.status]}</span></Show>
                </button>
                <span class="c-total q-mono">{totals().get(pl.id)?.total ?? 0}</span>
                <Show when={!p.readonly}>
                  <button type="button" class="c-step" title={`Retirer ${step()} point(s)`} onClick={() => void p.act({ type: "score.adjust", target: { participantId: pl.id }, delta: -step(), reason: "penalty" })}>−{step()}</button>
                  <button type="button" class="c-step" title={`Ajouter ${step()} point(s)`} onClick={() => void p.act({ type: "score.adjust", target: { participantId: pl.id }, delta: step(), reason: "bonus" })}>+{step()}</button>
                </Show>
              </div>
              <Show when={editing() === pl.id && !p.readonly}>
                <div class="c-player-edit">
                  <label class="c-field c-span">Nom <input value={pl.displayName} onChange={(e) => void p.act({ type: "player.rename", participantId: pl.id, displayName: e.currentTarget.value })} /></label>
                  <label class="c-field">Siège <input class="c-num" type="number" min="1" value={pl.seat ?? ""} onChange={(e) => void p.act({ type: "player.setSeat", participantId: pl.id, seat: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })} /></label>
                  <label class="c-field">Total <input class="c-num" type="number" value={totals().get(pl.id)?.total ?? 0} onChange={(e) => void p.act({ type: "score.setTotal", target: { participantId: pl.id }, total: Math.round(Number(e.currentTarget.value)) })} /></label>
                  <label class="c-field">Équipe
                    <select value={pl.teamId ?? ""} onChange={(e) => void p.act({ type: "player.setTeam", participantId: pl.id, teamId: e.currentTarget.value === "" ? null : e.currentTarget.value })}>
                      <option value="">—</option>
                      <For each={p.view.teams}>{(t) => <option value={t.id}>{t.name}</option>}</For>
                    </select>
                  </label>
                  <label class="c-field">Statut
                    <select value={pl.status} onChange={(e) => void p.act({ type: "player.setStatus", participantId: pl.id, status: asStatus(e.currentTarget.value) })}>
                      <For each={STATUSES}>{(s) => <option value={s}>{STATUS_LABEL_FR[s]}</option>}</For>
                    </select>
                  </label>
                  <div class="c-span c-row c-row-tight">
                    <Button kind="danger" onClick={() => void confirmDialog({ title: `Retirer ${pl.displayName} ?`, message: "Le joueur et ses points quittent la partie.", confirm: "Retirer", danger: true }).then((ok) => ok && p.act({ type: "player.remove", participantId: pl.id }))}>Retirer</Button>
                    <Button kind="ghost" onClick={() => setEditing(null)}>Fermer</Button>
                  </div>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={!p.readonly}>
        <div class="c-add">
          <input placeholder="Nouveau joueur" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          <Button kind="secondary" onClick={() => void add()}>Ajouter</Button>
        </div>
        <details class="c-csv">
          <summary>Importer des joueurs (coller depuis Excel / CSV : nom ; siège ; équipe)</summary>
          <textarea class="c-mono-area" rows={5} value={csv()} onInput={(e) => setCsv(e.currentTarget.value)} placeholder={"Ana;1;Rouges\nBo;2;Bleus"} />
          <Button onClick={() => void importCsv()}>Importer</Button>
        </details>
        <Show when={csvReport()}>{(r) => <p class="muted">{r()}</p>}</Show>
      </Show>
    </div>
  );
}
