import { answerKindLabel } from "@quiz/schema";
import { For, Match, Show, Switch, createResource, createSignal, type JSX } from "solid-js";
import { Button, MultiScoringPicker, confirmDialog } from "@quiz/ui";
import type { Action, ControlView, MechanicView } from "@quiz/schema";
import { answerText } from "@quiz/renderer";
import { REGRADABLE_KINDS, initialRegradeDraft, questionOnAir, regradeSpec } from "./logic.ts";

/**
 * Live corrections and after-show tools of the control room (doc 09): reserve questions, edit the text on air,
 * regrade with a preview, rehearsal bots, results export. Every button sends an intent or calls the server API.
 */

type Act = (a: Action, ok?: string) => Promise<boolean>;
/** Appends the control token to an API path. */
export type WithToken = (path: string) => string;

type Round = ControlView["rundown"][number];
type RundownQuestion = Round["questions"][number];

/** Reserve questions of a round: replace the question on air, or the next one between questions. */
export function ReserveList(p: { readonly view: ControlView; readonly round: Round; readonly readonly: boolean; readonly act: Act }): JSX.Element {
  const current = () => p.view.round?.index === p.round.index;
  const replace = async (id: string, text: string) => {
    const onAir = questionOnAir(p.view);
    const target = onAir ? `la question à l'écran (n° ${(p.view.question?.index ?? 0) + 1})` : "la prochaine question";
    if (!(await confirmDialog({ title: `Remplacer ${target} ?`, message: `Par la question de réserve « ${text} ». Les réponses déjà données à la question remplacée sont perdues.`, confirm: "Remplacer", danger: onAir }))) return;
    await p.act({ type: "question.replaceFromReserve", reserveId: id, ...(onAir && p.view.question !== null ? { questionIndex: p.view.question.index } : {}) }, "Question remplacée");
  };
  return (
    <Show when={p.round.reserve.length > 0}>
      <div class="c-reserve">
        <span class="muted">Réserve</span>
        <For each={p.round.reserve}>
          {(r) => (
            <div class="c-reserve-q">
              <span class="c-q-t">{r.text}</span>
              <Show when={!p.readonly}>
                <Button kind="ghost" disabled={!current() || p.view.phase === "revealed" || p.view.phase === "round.end" || p.view.phase === "game.end"} title="Remplacer par une question de réserve" onClick={() => void replace(r.id, r.text)}>Remplacer</Button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Inline edit of the question text on air (typo fix). */
export function QuestionTextEdit(p: { readonly text: string; readonly act: Act }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const save = async () => {
    const t = draft().trim();
    if (t.length === 0 || t === p.text) {
      setEditing(false);
      return;
    }
    if (await p.act({ type: "question.edit", text: t }, "Texte corrigé")) setEditing(false);
  };
  return (
    <Show when={editing()} fallback={<Button kind="ghost" onClick={() => { setDraft(p.text); setEditing(true); }}>✎ Modifier le texte</Button>}>
      <div class="c-edit">
        <textarea rows={3} maxlength={2000} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />
        <div class="c-row">
          <Button onClick={() => void save()}>Enregistrer</Button>
          <Button kind="ghost" onClick={() => setEditing(false)}>Annuler</Button>
        </div>
      </div>
    </Show>
  );
}

type Change = { participantId: string; name: string; before: number; after: number };

type Preview = { kind: "ok"; changes: Change[] } | { kind: "error"; error: string };
const changesOf = (p: Preview): Change[] => (p.kind === "ok" ? p.changes : []);
const errorOf = (p: Preview): string => (p.kind === "error" ? p.error : "");

/** Regrade of a played question: answer editor → preview of the totals → confirmation → `question.regrade`. */
export function RegradeEditor(p: { readonly question: RundownQuestion; readonly act: Act; readonly withToken: WithToken; readonly onClose: () => void }): JSX.Element {
  const spec = () => p.question.answerSpec;
  const init = initialRegradeDraft(p.question.answerSpec);
  const [picked, setPicked] = createSignal<string[]>(init.picked);
  const [truth, setTruth] = createSignal<boolean | undefined>(init.truth);
  const [accepted, setAccepted] = createSignal(init.accepted);
  const [correct, setCorrect] = createSignal(init.correct);
  const [tolerance, setTolerance] = createSignal(init.tolerance);
  const [order, setOrder] = createSignal<string[]>(init.order);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const next = () => regradeSpec(spec(), { picked: picked(), truth: truth(), accepted: accepted(), correct: correct(), tolerance: tolerance(), order: order() });
  const options = () => {
    const s = spec();
    return s.kind === "single" || s.kind === "multi" || s.kind === "allocation" ? s.options : [];
  };
  const onePick = () => spec().kind === "single" || spec().kind === "allocation";
  const labelOf = (id: string) => {
    const s = spec();
    return s.kind === "order" ? (s.options.find((o) => o.id === id)?.label ?? id) : id;
  };
  const move = (i: number, d: -1 | 1) => {
    const o = [...order()];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j] ?? "", o[i] ?? ""];
    setOrder(o);
    setPreview(null);
  };
  const toggle = (id: string) => {
    if (onePick()) setPicked([id]);
    else setPicked(picked().includes(id) ? picked().filter((x) => x !== id) : [...picked(), id]);
    setPreview(null);
  };
  const runPreview = async () => {
    const answerSpec = next();
    if (answerSpec === null) return;
    try {
      const res = await fetch(p.withToken("/api/regrade/preview"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionId: p.question.id, answerSpec }) });
      const body: unknown = await res.json();
      if (res.ok && typeof body === "object" && body !== null && "changes" in body && Array.isArray(body.changes)) setPreview({ kind: "ok", changes: body.changes as Change[] }); // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoint
      else setPreview({ kind: "error", error: typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `refusé (${res.status})` });
    } catch {
      setPreview({ kind: "error", error: "serveur injoignable" });
    }
  };
  const applyRegrade = async () => {
    const answerSpec = next();
    if (answerSpec === null || !(await confirmDialog({ title: "Corriger la réponse ?", message: "Les points de cette question sont recalculés pour tous les joueurs (annulable par undo).", confirm: "Corriger et recalculer" }))) return;
    if (await p.act({ type: "question.regrade", questionId: p.question.id, answerSpec }, "Réponse corrigée, points recalculés")) p.onClose();
  };
  return (
    <div class="c-regrade">
      <p class="c-prompt">{p.question.text}</p>
      <Show when={REGRADABLE_KINDS.has(spec().kind)} fallback={<p class="muted">La réponse d'une question « {answerKindLabel(spec().kind)} » ne se modifie pas ici : corriger joueur par joueur ci-dessous (✓ / ✗), ou ajuster les scores.</p>}>
        <Switch>
          <Match when={options().length > 0}>
            <div class="c-regrade-opts">
              <For each={options()}>
                {(o) => (
                  <label>
                    <input type={onePick() ? "radio" : "checkbox"} name={`rg-${p.question.id}`} checked={picked().includes(o.id)} onChange={() => toggle(o.id)} /> {o.label}
                  </label>
                )}
              </For>
            </div>
          </Match>
          <Match when={spec().kind === "order"}>
            <ol class="c-regrade-order">
              <For each={order()}>
                {(id, i) => (
                  <li>
                    <span class="c-grow">{labelOf(id)}</span>
                    <Button kind="ghost" title="Monter" disabled={i() === 0} onClick={() => move(i(), -1)}>▲</Button>
                    <Button kind="ghost" title="Descendre" disabled={i() === order().length - 1} onClick={() => move(i(), 1)}>▼</Button>
                  </li>
                )}
              </For>
            </ol>
          </Match>
          <Match when={spec().kind === "boolean"}>
            <div class="c-regrade-opts">
              <label><input type="radio" name={`rg-${p.question.id}`} checked={truth() === true} onChange={() => { setTruth(true); setPreview(null); }} /> Vrai</label>
              <label><input type="radio" name={`rg-${p.question.id}`} checked={truth() === false} onChange={() => { setTruth(false); setPreview(null); }} /> Faux</label>
            </div>
          </Match>
          <Match when={spec().kind === "text"}>
            <label class="muted">Réponses acceptées (une par ligne, la première est affichée)
              <textarea rows={4} value={accepted()} onInput={(e) => { setAccepted(e.currentTarget.value); setPreview(null); }} />
            </label>
          </Match>
          <Match when={spec().kind === "number"}>
            <div class="c-row">
              <label>Bonne valeur <input class="c-num" inputmode="decimal" value={correct()} onInput={(e) => { setCorrect(e.currentTarget.value); setPreview(null); }} /></label>
              <label>Tolérance ± <input class="c-num" inputmode="decimal" value={tolerance()} onInput={(e) => { setTolerance(e.currentTarget.value); setPreview(null); }} /></label>
            </div>
          </Match>
        </Switch>
        <div class="c-row">
          <Button kind="secondary" disabled={next() === null} onClick={() => void runPreview()}>Aperçu des points</Button>
          <Button kind="ghost" onClick={() => p.onClose()}>Fermer</Button>
        </div>
        <Show when={preview()}>
          {(pv) => (
            <Show when={pv().kind === "ok" ? changesOf(pv()) : null} fallback={<p class="c-err">{errorOf(pv())}</p>}>
              {(changes) => (
                <>
                  <Show when={changes().length > 0} fallback={<p class="muted">Aucun total ne change.</p>}>
                    <table class="c-regrade-table">
                      <thead><tr><th>Joueur</th><th>Avant</th><th>Après</th></tr></thead>
                      <tbody><For each={changes()}>{(c) => <tr><td>{c.name}</td><td>{c.before}</td><td><b>{c.after}</b></td></tr>}</For></tbody>
                    </table>
                  </Show>
                  <Button kind="danger" onClick={() => void applyRegrade()}>Valider la correction</Button>
                </>
              )}
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}

type RehearsalStatus = { running: boolean; settings: { bots: number; accuracy: number; latencyMs: number } | null; bots: number };

/** Rehearsal bots (doc 07): they answer like tablets. Never during a real show. */
export function RehearsalPanel(p: { readonly withToken: WithToken }): JSX.Element {
  const [bots, setBots] = createSignal(20);
  const [accuracy, setAccuracy] = createSignal(60);
  const [latency, setLatency] = createSignal(3);
  const [msg, setMsg] = createSignal<string | null>(null);
  const [status, { refetch }] = createResource(async (): Promise<RehearsalStatus | null> => {
    try {
      const r = await fetch(p.withToken("/api/rehearsal"));
      return r.ok ? ((await r.json()) as RehearsalStatus) : null; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoint
    } catch {
      return null;
    }
  });
  const start = async () => {
    if (!(await confirmDialog({ title: `Ajouter ${bots()} bot(s) à la partie ?`, message: "Uniquement pour une répétition, jamais pendant un vrai show : les bots sont des joueurs du journal.", confirm: "Lancer la répétition" }))) return;
    try {
      const r = await fetch(p.withToken("/api/rehearsal"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bots: bots(), accuracy: accuracy() / 100, latencyMs: Math.round(latency() * 1000) }) });
      const body: unknown = await r.json();
      if (r.ok && typeof body === "object" && body !== null && "bots" in body) setMsg(`${String(body.bots)} bot(s) en jeu${"refused" in body && Number(body.refused) > 0 ? ` · ${String(body.refused)} refusé(s) (maximum du format)` : ""}`);
      else setMsg(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `refusé (${r.status})`);
    } catch {
      setMsg("serveur injoignable");
    }
    void refetch();
  };
  const stop = async () => {
    if (!(await confirmDialog({ title: "Arrêter la répétition ?", message: "Tous les bots sont retirés, avec leurs points.", confirm: "Retirer les bots", danger: true }))) return;
    try {
      const r = await fetch(p.withToken("/api/rehearsal"), { method: "DELETE" });
      const body: unknown = await r.json();
      setMsg(typeof body === "object" && body !== null && "removed" in body ? `${String(body.removed)} bot(s) retiré(s)` : `refusé (${r.status})`);
    } catch {
      setMsg("serveur injoignable");
    }
    void refetch();
  };
  return (
    <div class="c-links">
      <p class="c-err">ATTENTION — jamais pendant un vrai show : les bots deviennent des joueurs de la partie.</p>
      <Show when={status()}>{(s) => <p class="muted">{s().running ? `Répétition en cours · ${s().bots} bot(s)` : "Aucune répétition en cours"}</p>}</Show>
      <div class="c-row">
        <label>Bots <input class="c-num" type="number" min="1" max="500" value={bots()} onInput={(e) => setBots(Math.max(1, Math.min(500, Math.round(Number(e.currentTarget.value) || 1))))} /></label>
        <label>Justes % <input class="c-num" type="number" min="0" max="100" value={accuracy()} onInput={(e) => setAccuracy(Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)))} /></label>
        <label>Délai s <input class="c-num" type="number" min="0" max="60" value={latency()} onInput={(e) => setLatency(Math.max(0, Math.min(60, Number(e.currentTarget.value) || 0)))} /></label>
      </div>
      <div class="c-row">
        <Button onClick={() => void start()}>Lancer les bots</Button>
        <Button kind="danger" disabled={status()?.running !== true && (status()?.bots ?? 0) === 0} onClick={() => void stop()}>Arrêter et retirer</Button>
      </div>
      <Show when={msg()}>{(m) => <p class="muted">{m()}</p>}</Show>
    </div>
  );
}

/** After the show (doc 09): ranking / detail CSV, printable results (print to PDF from the browser). */
export function ResultsPanel(p: { readonly withToken: WithToken }): JSX.Element {
  return (
    <div class="c-links">
      <a class="q-btn q-btn-secondary" href={p.withToken("/api/results?kind=ranking")} download="resultats-ranking.csv">Classement CSV</a>
      <a class="q-btn q-btn-secondary" href={p.withToken("/api/results?kind=detail")} download="resultats-detail.csv">Détail CSV</a>
      <a class="q-btn q-btn-secondary" href={p.withToken("/api/results?format=html")} target="_blank" rel="noopener">Résultats imprimables (PDF)</a>
      <p class="muted">Pour le PDF : ouvrir, puis Imprimer → Enregistrer au format PDF.</p>
    </div>
  );
}

type PastRow = { participantId: string; name: string; optionIds: string[]; auto: boolean | null; forced: boolean | null };
type PastAnswers = { questionId: string; mechanic: MechanicView; rows: PastRow[] };

/**
 * « Corriger » on a question already revealed: every player's answer with its verdict; ✓ / ✗ force it (cheating, a
 * fair answer refused…), the same key again goes back to automatic. Points are rewritten at once (journaled, undoable).
 */
export function PastVerdicts(p: { readonly round: number; readonly question: number; readonly pointsKey: string; readonly act: Act; readonly withToken: WithToken }): JSX.Element {
  // Reloaded after each correction made here and whenever the points change elsewhere (entries added OR voided:
  // « wrong » voids without adding), never at every answer of the question on air.
  const [mine, setMine] = createSignal(0);
  const [data] = createResource(
    () => `${p.round}:${p.question}:${p.pointsKey}:${mine()}`,
    async (): Promise<PastAnswers | { error: string }> => {
      const r = await fetch(p.withToken(`/api/question-answers?round=${p.round}&question=${p.question}`)).catch(() => null);
      if (r === null) return { error: "serveur injoignable" };
      if (r.status === 404) return { error: "Question pas encore révélée : corriger les joueurs pendant la question, depuis « À l'antenne »." };
      if (!r.ok) return { error: `lecture impossible (${r.status})` };
      return (await r.json()) as PastAnswers; // oxlint-disable-line typescript/no-unsafe-type-assertion -- own server endpoint
    },
  );
  const ok = (): PastAnswers | null => { const d = data(); return d !== undefined && "rows" in d ? d : null; };
  const set = (row: PastRow, correct: boolean | null) =>
    void p.act({ type: "answer.verdict", roundIndex: p.round, questionIndex: p.question, participantId: row.participantId, correct }, correct === null ? `${row.name} : verdict automatique` : `${row.name} compté ${correct ? "juste" : "faux"} — points recalculés`).then(() => setMine((n) => n + 1));
  return (
    <Show when={ok()} fallback={<p class="muted">{(() => { const d = data(); return d !== undefined && "error" in d ? d.error : "Chargement…"; })()}</p>}>
      {(d) => (
        <div class="c-past">
          <MultiScoringPicker questionId={d().questionId} mechanic={d().mechanic} revealed readonly={false} act={(a, t) => p.act(a, t).then((done) => { setMine((n) => n + 1); return done; })} />
          <span class="q-label">Réponses des joueurs ({d().rows.length}) — corriger un verdict</span>
          <ul class="q-mech-review">
            <For each={d().rows} fallback={<li class="muted">Personne n'a répondu.</li>}>
              {(row) => {
                const now = () => row.forced ?? row.auto;
                return (
                  <li data-accepted={String(now())}>
                    <span class="q-mech-who">{row.name}</span>
                    <span class="q-mech-said">{row.optionIds.length === 0 ? "—" : answerText(d().mechanic, row.optionIds)}</span>
                    <Show when={row.forced !== null}><span class="q-mech-tag">corrigé</span></Show>
                    <span class="q-mech-verdict">
                      <button type="button" class="q-toggle" data-on={String(now() === true)} title={row.forced === true ? "Revenir au verdict automatique" : "Compter juste"} onClick={() => set(row, row.forced === true ? null : true)}>✓</button>
                      <button type="button" class="q-toggle q-toggle-no" data-on={String(now() === false)} title={row.forced === false ? "Revenir au verdict automatique" : "Compter faux"} onClick={() => set(row, row.forced === false ? null : false)}>✗</button>
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        </div>
      )}
    </Show>
  );
}

