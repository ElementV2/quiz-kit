import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from "solid-js";
import { defaultRegistry, pointsInfo } from "@quiz/engine";
import { GameDocument, ruleSummary, type Round, type ScoringComponent } from "@quiz/schema";
import { Button, Panel, confirmDialog } from "@quiz/ui";
import { JsonField, NumField } from "./fields.tsx";
import { FlowEditor } from "./flow-editor.tsx";
import { MECHANICS, MIXED_CATEGORIES, normalizeRule, SCORING_LABEL, mechanicLabel, mixedCategoryCounts, mixedCategoryValues, mixedScoring, setMixedField, setMixedScoring, addToRound, configValues, deleteRound, duplicateRound, mechanicOptions, moveItem, newRound, newScoring, parseNumberList, removeFromRound, roundIssues, setConfigField, setMechanic, swapList, type ConfigField, type RoundIssue, type RoundList } from "./format-logic.ts";
import { kindLabel } from "./question-factories.ts";
import { clone, hex, snapshot, type Update } from "./util.ts";

const PARTICIPANTS = [["solo", "Joueurs individuels"], ["teams", "Équipes"], ["crowd", "Public (grand nombre)"]] as const;
/** The number a scoring block edits. */
function scoreValue(c: ScoringComponent): number {
  if (c.type === "timeDecay") return c.minPoints;
  return c.type === "multiplier" ? c.factor : c.points;
}

const SCORING_TYPES = ["base", "timeDecay", "penalty", "multiplier"] as const satisfies readonly ScoringComponent["type"][];

/** Format mode (doc 07): the game's rounds as cards (« Liste »), or the show flow as a node graph (« Enchaînement »). */
export function FormatEditor(p: { doc: GameDocument; update: Update }): JSX.Element {
  const [mode, setMode] = createSignal<"list" | "flow">("list");
  const doc = createMemo(() => snapshot(p.doc));
  const issues = createMemo(() => doc().format.rounds.map((_, ri) => roundIssues(doc(), ri, defaultRegistry)));
  const schemaIssues = createMemo(() => {
    const v = GameDocument.safeParse(doc());
    return v.success ? [] : v.error.issues;
  });
  // Schema issues of the round not already said in French by roundIssues (empty round, unknown question).
  const roundSchemaIssues = (ri: number): string[] => schemaIssues().filter((i) => i.path[0] === "format" && i.path[1] === "rounds" && i.path[2] === ri && i.path[3] !== "questions" && !i.message.includes("question inconnue")).map((i) => i.message);
  const fmt = (f: (d: GameDocument["format"]) => void, key?: string) => p.update((d) => f(d.format), key);
  return (
    <div class="s-format" data-mode={mode()}>
      <Panel title="Format de la partie">
        <div class="s-format-head">
          <label class="s-field"><span class="s-label">Nom du format</span><input value={p.doc.format.name} onInput={(e) => { const v = e.currentTarget.value; if (v.length > 0) fmt((f) => { f.name = v; }, "fname"); }} /></label>
          <label class="s-field"><span class="s-label">Qui joue</span>
            <select value={p.doc.format.participants.mode} onChange={(e) => { const m = PARTICIPANTS.find(([v]) => v === e.currentTarget.value)?.[0]; if (m !== undefined) fmt((f) => { f.participants.mode = m; }); }}>
              <For each={PARTICIPANTS}>{([v, label]) => <option value={v}>{label}</option>}</For>
            </select>
          </label>
          <label class="s-field"><span class="s-label">Minimum</span><NumField min={0} value={p.doc.format.participants.min} onChange={(v) => fmt((f) => { f.participants.min = Math.max(0, Math.round(v)); })} /></label>
          <label class="s-field"><span class="s-label">Maximum</span><NumField min={1} value={p.doc.format.participants.max} onChange={(v) => fmt((f) => { f.participants.max = Math.max(1, Math.round(v)); })} /></label>
          <Show when={p.doc.format.participants.mode === "teams"}>
            <label class="s-field"><span class="s-label">Joueurs par équipe</span><NumField min={1} value={p.doc.format.participants.teamSize} placeholder="libre" onChange={(v) => fmt((f) => { f.participants.teamSize = Math.max(1, Math.round(v)); })} onEmpty={() => fmt((f) => { delete f.participants.teamSize; })} /></label>
          </Show>
          <label class="s-field"><span class="s-label">En cas d'égalité</span>
            <select value={p.doc.format.tieBreak} onChange={(e) => { const v = e.currentTarget.value === "speed" ? "speed" : "control"; fmt((f) => { f.tieBreak = v; }); }}>
              <option value="speed">rapidité cumulée (le plus rapide gagne)</option>
              <option value="control">décision régie / barrage</option>
            </select>
          </label>
        </div>
      </Panel>
      <div class="s-row s-format-mode">
        <div class="s-seg" role="group" aria-label="Vue du format">
          <button type="button" data-on={String(mode() === "list")} onClick={() => setMode("list")}>Liste</button>
          <button type="button" data-on={String(mode() === "flow")} onClick={() => setMode("flow")}>Enchaînement</button>
        </div>
        <span class="muted s-hint">{mode() === "list" ? "Les manches, leur contenu et leurs règles, dans l'ordre de la liste." : "Ce qui suit chaque manche : ordre de la liste, ou transitions (égalité → barrage…)."}</span>
      </div>
      <Show when={mode() === "flow"} fallback={
        <>
          <ol class="s-rounds">
            <For each={p.doc.format.rounds}>
              {(r, ri) => <RoundCard doc={p.doc} round={r} ri={ri()} count={p.doc.format.rounds.length} issues={issues()[ri()] ?? []} schemaIssues={roundSchemaIssues(ri())} update={p.update} />}
            </For>
          </ol>
          <Button onClick={() => p.update((d) => { d.format.rounds.push(newRound(defaultRegistry, `r_${hex(4)}`, d.format.rounds.length + 1)); })}>+ Ajouter une manche</Button>
        </>
      }>
        <FlowEditor doc={p.doc} update={p.update} />
      </Show>
    </div>
  );
}

function RoundCard(p: { doc: GameDocument; round: Round; ri: number; count: number; issues: readonly RoundIssue[]; schemaIssues: readonly string[]; update: Update }): JSX.Element {
  const [special, setSpecial] = createSignal(false);
  const edit = (f: (r: Round) => void, key?: string) => p.update((d) => { const r = d.format.rounds[p.ri]; if (r !== undefined) f(r); }, key === undefined ? undefined : `${p.round.id}:${key}`);
  const info = () => MECHANICS[p.round.mechanic];
  const general = () => p.issues.filter((i) => i.questionId === null || !p.doc.questions.some((q) => q.id === i.questionId));
  const remove = async () => {
    if (!(await confirmDialog({ title: `Supprimer la manche « ${p.round.title} » ?`, message: "Ses questions restent dans la banque. Annulable (Ctrl+Z).", confirm: "Supprimer", danger: true }))) return;
    p.update((d) => { deleteRound(d, p.ri); });
  };
  return (
    <li class="s-round" data-bad={String(p.issues.length + p.schemaIssues.length > 0)}>
      <header class="s-round-head">
        <span class="s-round-num q-mono">{String(p.ri + 1).padStart(2, "0")}</span>
        <input class="s-round-title" aria-label="Titre de la manche" value={p.round.title} onInput={(e) => { const v = e.currentTarget.value; if (v.length > 0) edit((r) => { r.title = v; }, "title"); }} />
        <span class="s-spacer" />
        <Button kind="ghost" title="Monter la manche" disabled={p.ri === 0} onClick={() => p.update((d) => moveItem(d.format.rounds, p.ri, p.ri - 1))}>↑</Button>
        <Button kind="ghost" title="Descendre la manche" disabled={p.ri === p.count - 1} onClick={() => p.update((d) => moveItem(d.format.rounds, p.ri, p.ri + 1))}>↓</Button>
        <Button kind="secondary" onClick={() => p.update((d) => duplicateRound(d, p.ri, `r_${hex(4)}`))}>Dupliquer</Button>
        <Button kind="danger" disabled={p.count <= 1} title={p.count <= 1 ? "Un format a au moins une manche" : "Supprimer la manche"} onClick={() => void remove()}>Supprimer</Button>
      </header>
      <Show when={general().length + p.schemaIssues.length > 0}>
        <ul class="s-issues">
          <For each={general()}>{(i) => <li>⚠ {i.message}</li>}</For>
          <For each={p.schemaIssues}>{(m) => <li>⚠ {m}</li>}</For>
        </ul>
      </Show>
      <div class="s-round-body">
        <div class="s-round-col">
          {/*
            A round takes every kind of question (« Mixte »): no type to pick. Special formats (rules for the whole round:
            ladder, board, all on the buzzer…) stay one click away, never in the way.
          */}
          <Show
            when={p.round.mechanic !== "mixed" || special()}
            fallback={
              <p class="s-explain s-normal">
                <span class="muted">Tous les types de questions dans cette manche, chacun avec ses réglages.</span>
                <button type="button" class="s-link" onClick={() => setSpecial(true)}>Format spécial…</button>
              </p>
            }
          >
            <label class="s-field"><span class="s-label">Format spécial de la manche</span>
              <select value={p.round.mechanic} onChange={(e) => { const v = e.currentTarget.value; p.update((d) => setMechanic(d, p.ri, v, defaultRegistry)); if (v === "mixed") setSpecial(false); }}>
                {/* A partie launched before « Mixte » existed (live edit): its round type stays visible. */}
                <Show when={!mechanicOptions(defaultRegistry).some((m) => m.id === p.round.mechanic)}>
                  <option value={p.round.mechanic} disabled>{mechanicLabel(p.round.mechanic)} (partie lancée avant « Mixte »)</option>
                </Show>
                <option value="mixed">Aucun : manche normale (tous types de questions)</option>
                <For each={mechanicOptions(defaultRegistry).filter((m) => m.special)}>{(m) => <option value={m.id}>{m.label}</option>}</For>
              </select>
            </label>
            <Show when={p.round.mechanic !== "mixed"}><p class="muted s-explain">{info()?.explain ?? "Mécanique sans description."}</p></Show>
          </Show>
          <QuestionList title="Questions jouées (dans l'ordre)" list="questions" doc={p.doc} round={p.round} ri={p.ri} issues={p.issues} update={p.update} />
          <QuestionList title="Réserve (questions de secours)" list="reserve" doc={p.doc} round={p.round} ri={p.ri} issues={p.issues} update={p.update} />
        </div>
        <div class="s-round-col">
          <div class="s-section">
            <span class="s-label">Chrono</span>
            <div class="s-row">
              <label class="s-inline"><input type="checkbox" checked={p.round.timer !== undefined} onChange={(e) => { const on = e.currentTarget.checked; edit((r) => { if (on) r.timer = { durationMs: 20_000, autoLock: true }; else delete r.timer; }); }} /> chrono</label>
              <Show when={p.round.timer}>
                {(t) => (
                  <>
                    <label class="s-inline"><NumField min={1} max={3600} value={Math.round(t().durationMs / 1000)} onChange={(v) => edit((r) => { if (r.timer !== undefined) r.timer.durationMs = Math.min(3600, Math.max(1, Math.round(v))) * 1000; })} /> secondes</label>
                    <label class="s-inline"><input type="checkbox" checked={t().autoLock} onChange={(e) => { const on = e.currentTarget.checked; edit((r) => { if (r.timer !== undefined) r.timer.autoLock = on; }); }} /> fermer les réponses à la fin</label>
                  </>
                )}
              </Show>
            </div>
          </div>
          <ScoringBlocks round={p.round} edit={edit} usesScoring={info()?.usesScoring ?? true} />
          <Show when={p.round.mechanic === "mixed"} fallback={<ConfigForm round={p.round} ri={p.ri} update={p.update} />}>
            <MixedSettings doc={p.doc} round={p.round} ri={p.ri} update={p.update} />
          </Show>
        </div>
      </div>
    </li>
  );
}

function QuestionList(p: { title: string; list: RoundList; doc: GameDocument; round: Round; ri: number; issues: readonly RoundIssue[]; update: Update }): JSX.Element {
  const ids = () => p.round[p.list];
  const byId = createMemo(() => new Map(p.doc.questions.map((q) => [q.id, q])));
  const candidates = () => p.doc.questions.filter((q) => !p.round.questions.includes(q.id) && !p.round.reserve.includes(q.id));
  const elsewhere = (qid: string) => p.doc.format.rounds.flatMap((r, i) => (i !== p.ri && r.questions.includes(qid) ? [String(i + 1)] : []));
  return (
    <div class="s-section">
      <span class="s-label">{p.title} <span class="q-mono">· {ids().length}</span></span>
      <ol class="s-qlist">
        <For each={ids()} fallback={<li class="muted s-empty-row">{p.list === "questions" ? "Aucune question : en ajouter une ci-dessous." : "Aucune question en réserve."}</li>}>
          {(qid, i) => {
            const q = () => byId().get(qid);
            const warn = () => p.issues.filter((x) => x.questionId === qid && q() !== undefined);
            return (
              <li data-bad={String(warn().length > 0)}>
                <div class="s-qrow">
                  <span class="q-mono muted">{i() + 1}</span>
                  <span class="s-kind">{q() === undefined ? "?" : kindLabel(q()?.answerSpec.kind ?? "single")}</span>
                  <span class="s-qtext" title={q()?.prompt.text}>{q()?.prompt.text ?? qid}</span>
                  <Show when={q()}>{(qq) => { const w = () => pointsInfo(p.round, qq(), defaultRegistry); return <span class="s-worth" title={`D'où viennent ses points : ${w().why}`} data-source={w().source}>{w().summary}</span>; }}</Show>
                  <Button kind="ghost" title="Monter" disabled={i() === 0} onClick={() => p.update((d) => { const r = d.format.rounds[p.ri]; if (r !== undefined) moveItem(r[p.list], i(), i() - 1); })}>↑</Button>
                  <Button kind="ghost" title="Descendre" disabled={i() === ids().length - 1} onClick={() => p.update((d) => { const r = d.format.rounds[p.ri]; if (r !== undefined) moveItem(r[p.list], i(), i() + 1); })}>↓</Button>
                  <Button kind="ghost" title={p.list === "questions" ? "Mettre en réserve" : "Jouer cette question"} onClick={() => p.update((d) => swapList(d, p.ri, qid, p.list === "questions" ? "reserve" : "questions"))}>{p.list === "questions" ? "→ réserve" : "→ jouer"}</Button>
                  <Button kind="ghost" title="Retirer de la manche (reste dans la banque)" onClick={() => p.update((d) => removeFromRound(d, p.ri, qid, p.list))}>✕</Button>
                </div>
                <For each={warn()}>{(w) => <p class="s-warn-text">⚠ question incompatible : {w.message}</p>}</For>
              </li>
            );
          }}
        </For>
      </ol>
      <select class="s-add-q" value="" aria-label={`Ajouter à : ${p.title}`} onChange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ""; if (v !== "") p.update((d) => addToRound(d, p.ri, v, p.list)); }}>
        <option value="">+ ajouter une question de la banque…</option>
        <For each={candidates()}>
          {(q) => {
            const other = elsewhere(q.id);
            return <option value={q.id}>{kindLabel(q.answerSpec.kind)} · {q.prompt.text.slice(0, 70)}{other.length > 0 ? ` (déjà en manche ${other.join(", ")})` : ""}</option>;
          }}
        </For>
      </select>
    </div>
  );
}

function ScoringBlocks(p: { round: Round; edit: (f: (r: Round) => void, key?: string) => void; usesScoring: boolean }): JSX.Element {
  return (
    <RuleEditor
      title={p.round.mechanic === "mixed" ? "Barème de la manche (toutes les catégories sans barème propre)" : "Barème"}
      rule={p.round.scoring}
      editRule={(f) => p.edit((r) => { f(r.scoring); normalizeRule(r.scoring); })}
      off={!p.usesScoring}
      round={p.round}
    />
  );
}

/** Edits one points rule (the round's, or a category's own in a mixed round). */
function RuleEditor(p: { title: string; rule: readonly ScoringComponent[]; editRule: (f: (rule: ScoringComponent[]) => void) => void; off?: boolean; round?: Round }): JSX.Element {
  const setValue = (ci: number, v: number) => p.editRule((rule) => {
    const c = rule[ci];
    if (c === undefined) return;
    switch (c.type) {
      case "base":
        c.points = Math.round(v);
        break;
      case "penalty":
        c.points = Math.min(0, -Math.abs(Math.round(v)));
        break;
      case "timeDecay":
        c.minPoints = Math.round(v);
        break;
      case "multiplier":
        if (v > 0) c.factor = v;
        break;
    }
  });
  const unit: Record<ScoringComponent["type"], string> = { base: "points", timeDecay: "points au minimum", penalty: "points", multiplier: "×" };
  const available = () => SCORING_TYPES.filter((t) => t !== "timeDecay" || !p.rule.some((c) => c.type === "timeDecay"));
  return (
    <div class="s-section">
      <span class="s-label">{p.title}</span>
      <Show when={p.off === true}><p class="muted s-hint">Cette mécanique calcule elle-même ses points (réglages ci-dessous) : le barème n'est pas utilisé.</p></Show>
      <div class="s-scoring" data-off={String(p.off === true)}>
        <For each={p.rule}>
          {(c, ci) => (
            <div class="s-score-row">
              <span>{SCORING_LABEL[c.type]}</span>
              <NumField label={`${SCORING_LABEL[c.type]} (${unit[c.type]})`} step={c.type === "multiplier" ? 0.5 : 10} value={scoreValue(c)} onChange={(v) => setValue(ci(), v)} />
              <span class="muted">{unit[c.type]}</span>
              <Button kind="ghost" title="Retirer la règle" disabled={p.rule.length <= 1} onClick={() => p.editRule((rule) => { rule.splice(ci(), 1); })}>✕</Button>
            </div>
          )}
        </For>
      </div>
      <select value="" aria-label="Ajouter une règle de score" onChange={(e) => { const t = SCORING_TYPES.find((x) => x === e.currentTarget.value); e.currentTarget.value = ""; if (t !== undefined) p.editRule((rule) => { rule.push(newScoring(t)); }); }}>
        <option value="">+ ajouter une règle…</option>
        <For each={available()}>{(t) => <option value={t}>{SCORING_LABEL[t]}</option>}</For>
      </select>
      <Show when={p.rule.some((c) => c.type === "timeDecay")}><p class="muted s-hint">Dégressif : les points baissent de la base jusqu'au minimum pendant le temps de réponse.</p></Show>
      <Show when={p.round?.mechanic === "mixed"}>
        <p class="s-hint s-priority">Priorité des points, du plus fort au plus faible : <b>1.</b> les points de la question (onglet Contenu) · <b>2.</b> le barème de sa catégorie (ci-dessous) · <b>3.</b> ce barème de la manche. En direct, la <b>mise</b> de la régie (×2, points…) s'applique par-dessus, pour une question.</p>
      </Show>
    </div>
  );
}

/**
 * « Mixte » round: one block per question category — its settings and, when it scores by the barème, its own
 * points rule or the round's. Categories used by the round come first, open.
 */
function MixedSettings(p: { doc: GameDocument; round: Round; ri: number; update: Update }): JSX.Element {
  const counts = createMemo(() => mixedCategoryCounts(p.doc, p.round));
  const ordered = createMemo(() => MIXED_CATEGORIES.toSorted((a, b) => Number((counts().get(b.id) ?? 0) > 0) - Number((counts().get(a.id) ?? 0) > 0)));
  return (
    <div class="s-section s-mixed">
      <span class="s-label">Réglages par catégorie de question</span>
      <For each={ordered()}>
        {(c) => {
          const n = () => counts().get(c.id) ?? 0;
          const values = createMemo(() => mixedCategoryValues(defaultRegistry, p.round, c.id));
          const own = () => mixedScoring(p.round, c.id);
          return (
            <details class="s-cat" open={n() > 0} data-used={String(n() > 0)}>
              <summary><span class="s-cat-name">{c.label}</span> <span class="muted q-mono">{n() > 0 ? `${n()} question(s)` : "aucune question"}</span></summary>
              <p class="muted s-hint">{c.explain}</p>
              <For each={c.fields}>{(f) => <ConfigInput field={f} values={values()} set={(key, v) => p.update((d) => setMixedField(d, p.ri, c.id, key, v))} />}</For>
              <Show when={c.ownPoints !== true} fallback={<p class="muted s-hint">Points décidés par la catégorie elle-même (pas de barème).</p>}>
                <label class="s-inline s-check">
                  <input type="checkbox" checked={own() !== null} onChange={(e) => { const on = e.currentTarget.checked; p.update((d) => setMixedScoring(d, p.ri, c.id, on ? clone([...p.round.scoring]) : null)); }} />
                  Barème propre à cette catégorie (sinon celui de la manche)
                </label>
                <Show when={own() === null}><p class="muted s-hint">Ces questions rapportent le barème de la manche : {ruleSummary(p.round.scoring)} (sauf celles qui ont leurs propres points).</p></Show>
                <Show when={own()}>
                  {(rule) => (
                    <RuleEditor
                      title={`Barème — ${c.label}`}
                      rule={rule()}
                      editRule={(f) => p.update((d) => { const r = d.format.rounds[p.ri]; const cur = r === undefined ? null : mixedScoring(r, c.id); if (cur === null) return; const next = clone(cur); f(next); setMixedScoring(d, p.ri, c.id, normalizeRule(next)); })}
                    />
                  )}
                </Show>
              </Show>
            </details>
          );
        }}
      </For>
    </div>
  );
}

function ConfigForm(p: { round: Round; ri: number; update: Update }): JSX.Element {
  const values = createMemo(() => configValues(defaultRegistry, p.round));
  const set = (key: string, v: unknown) => p.update((d) => setConfigField(d, p.ri, key, v));
  const fields = () => MECHANICS[p.round.mechanic]?.fields ?? [];
  return (
    <div class="s-section">
      <span class="s-label">Réglages de la mécanique</span>
      <Show when={fields().length > 0} fallback={<p class="muted s-hint">Aucun réglage.</p>}>
        <For each={fields()}>{(f) => <ConfigInput field={f} values={values()} set={set} />}</For>
      </Show>
      <details class="s-fold">
        <summary>Avancé (JSON)</summary>
        <JsonField label="Configuration brute" value={p.round.mechanicConfig} onChange={(v) => p.update((d) => { const r = d.format.rounds[p.ri]; if (r !== undefined) r.mechanicConfig = v; })} />
      </details>
    </div>
  );
}

function ConfigInput(p: { field: ConfigField; values: Record<string, unknown>; set: (key: string, v: unknown) => void }): JSX.Element {
  const v = () => p.values[p.field.key];
  const nums = (key: string): number[] => {
    const x = p.values[key];
    return Array.isArray(x) ? x.filter((n): n is number => typeof n === "number") : [];
  };
  const strs = (key: string): string[] => {
    const x = p.values[key];
    return Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : [];
  };
  const [bad, setBad] = createSignal(false);
  const f = p.field;
  return (
    <Switch>
      <Match when={f.kind === "boolean" && f}>
        {(b) => <label class="s-inline s-check"><input type="checkbox" checked={v() === true} onChange={(e) => p.set(b().key, e.currentTarget.checked)} /> {b().label}</label>}
      </Match>
      <Match when={f.kind === "number" && f}>
        {(n) => <label class="s-field-row"><span>{n().label}</span><NumField min={n().min} max={n().max} step={n().step ?? 1} value={typeof v() === "number" ? Number(v()) : undefined} onChange={(x) => p.set(n().key, n().step === undefined ? Math.round(x) : x)} /></label>}
      </Match>
      <Match when={f.kind === "enum" && f}>
        {(en) => (
          <label class="s-field-row"><span>{en().label}</span>
            <select value={typeof v() === "string" ? String(v()) : ""} onChange={(e) => p.set(en().key, e.currentTarget.value)}>
              <For each={en().options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
            </select>
          </label>
        )}
      </Match>
      <Match when={f.kind === "numbers" && f}>
        {(l) => (
          <label class="s-field"><span class="s-label">{l().label}</span>
            <input class="q-mono" data-bad={String(bad())} placeholder={l().hint} value={nums(l().key).join(", ")} onChange={(e) => { const list = parseNumberList(e.currentTarget.value); setBad(list === null || list.length === 0); if (list !== null && list.length > 0) p.set(l().key, list.map((x) => Math.round(x))); }} />
            <Show when={bad()}><span class="s-warn-text">Saisir des nombres séparés par des virgules.</span></Show>
          </label>
        )}
      </Match>
      <Match when={f.kind === "indexFlags" && f}>
        {(ix) => (
          <div class="s-field"><span class="s-label">{ix().label}</span>
            <div class="s-flags">
              <For each={nums(ix().of)}>{(amount, i) => <label class="s-inline"><input type="checkbox" checked={nums(ix().key).includes(i())} onChange={(e) => { const on = e.currentTarget.checked; const cur = nums(ix().key).filter((x) => x !== i()); p.set(ix().key, (on ? [...cur, i()] : cur).toSorted((a, b) => a - b)); }} /> <span class="q-mono">{i() + 1} · {amount}</span></label>}</For>
            </div>
          </div>
        )}
      </Match>
      <Match when={f.kind === "text" && f}>
        {(t) => (
          <label class="s-field"><span class="s-label">{t().label}</span>
            <input value={typeof v() === "string" ? String(v()) : ""} placeholder={t().placeholder} onChange={(e) => { const x = e.currentTarget.value.trim(); p.set(t().key, x === "" ? undefined : x); }} />
          </label>
        )}
      </Match>
      <Match when={f.kind === "flags" && f}>
        {(fl) => (
          <div class="s-field"><span class="s-label">{fl().label}</span>
            <div class="s-flags">
              <For each={fl().options}>{(o) => <label class="s-inline"><input type="checkbox" checked={strs(fl().key).includes(o.value)} onChange={(e) => { const on = e.currentTarget.checked; const cur = strs(fl().key).filter((x) => x !== o.value); p.set(fl().key, on ? [...cur, o.value] : cur); }} /> {o.label}</label>}</For>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}
