import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from "solid-js";
import { defaultRegistry, pointsInfo } from "@quiz/engine";
import { parseQuestionsCsv, type AnswerKind, type AnswerSpec, type GameDocument, type NormRect, type Question } from "@quiz/schema";
import { Button, Panel, confirmDialog } from "@quiz/ui";
import { api, mediaUrl } from "./api.ts";
import { NumField } from "./fields.tsx";
import { deleteQuestion, moveItem, pointsRule, questionPoints, roundIssues, roundsOf, type QuestionPoints } from "./format-logic.ts";
import { QUESTION_TYPES, freeOptionId, kindLabel, newQuestion, normRectFromDrag, splitList } from "./question-factories.ts";
import { hex, snapshot, type Update } from "./util.ts";

type SpecOf<K extends AnswerKind> = Extract<AnswerSpec, { kind: K }>;
const isKind = <K extends AnswerKind>(s: AnswerSpec, k: K): s is SpecOf<K> => s.kind === k;
type EditQ = (f: (q: Question) => void, key?: string) => void;

const BANK_ONLY = "";

/** Content mode (doc 07): the question bank. Rounds only reference questions (Format tab). */
export function ContentEditor(p: { doc: GameDocument; update: Update }): JSX.Element {
  const [paste, setPaste] = createSignal("");
  const pasted = createMemo(() => parseQuestionsCsv(paste()));
  const [targetSel, setTargetSel] = createSignal<string | null>(null);
  const [msg, setMsg] = createSignal<string | null>(null);
  /** Round receiving new questions: chosen, else the last round. */
  const target = () => {
    const t = targetSel();
    if (t !== null && (t === BANK_ONLY || p.doc.format.rounds.some((r) => r.id === t))) return t;
    return p.doc.format.rounds.at(-1)?.id ?? BANK_ONLY;
  };
  const targetTitle = () => p.doc.format.rounds.find((r) => r.id === target())?.title ?? null;
  const issuesByQuestion = createMemo(() => {
    const doc = snapshot(p.doc);
    const out = new Map<string, string[]>();
    doc.format.rounds.forEach((r, ri) => {
      for (const i of roundIssues(doc, ri, defaultRegistry)) if (i.questionId !== null) out.set(i.questionId, [...(out.get(i.questionId) ?? []), `${r.title} : ${i.message}`]);
    });
    return out;
  });
  const addQuestions = (qs: readonly Question[]) => p.update((d) => {
    const rid = target();
    for (const q of qs) {
      d.questions.push(q);
      d.format.rounds.find((r) => r.id === rid)?.questions.push(q.id);
    }
  });
  const add = (kind: AnswerKind) => {
    addQuestions([newQuestion(kind, `q_${hex(6)}`)]);
    setMsg(targetTitle() === null ? "Question ajoutée à la banque (dans aucune manche)." : `Question ajoutée à « ${targetTitle() ?? ""} ».`);
  };
  const importPaste = () => {
    addQuestions(pasted().questions.map((q) => ({ ...q, id: `q_${hex(6)}` })));
    setPaste("");
  };
  const remove = async (q: Question) => {
    const where = roundsOf(p.doc, q.id);
    // Dry run on a copy first: a refused delete must not even ask (nor leave an empty undo step).
    const dry = deleteQuestion(snapshot(p.doc), q.id);
    if (!dry.ok) {
      setMsg(`Suppression impossible : ${dry.reason}.`);
      return;
    }
    if (!(await confirmDialog({ title: "Supprimer cette question ?", message: `« ${q.prompt.text.slice(0, 80)} »${where.length > 0 ? `\nElle sera retirée de : ${where.join(", ")}.` : ""}\nAnnulable (Ctrl+Z).`, confirm: "Supprimer", danger: true }))) return;
    p.update((d) => { deleteQuestion(d, q.id); });
    setMsg("Question supprimée.");
  };
  return (
    <div class="s-content">
      <div class="s-toolbar s-addbar">
        <span class="s-label">Ajouter une question</span>
        <For each={QUESTION_TYPES}>{(t) => <Button kind={t.kind === "single" ? "primary" : "secondary"} title={t.help} onClick={() => add(t.kind)}>+ {t.label}</Button>}</For>
      </div>
      <div class="s-toolbar">
        <label class="s-inline">dans la manche
          <select value={target()} onChange={(e) => setTargetSel(e.currentTarget.value)}>
            <For each={p.doc.format.rounds}>{(r, i) => <option value={r.id}>{i() + 1}. {r.title}</option>}</For>
            <option value={BANK_ONLY}>aucune (banque seulement)</option>
          </select>
        </label>
        <span class="muted q-mono">{p.doc.questions.length} question(s)</span>
        <Show when={msg()}>{(m) => <span class="s-report">{m()}</span>}</Show>
      </div>
      <table class="s-table">
        <thead><tr><th>#</th><th>Question</th><th>Réponse</th><th>Média</th><th>Indices, catégories, notes</th><th /></tr></thead>
        <tbody>
          <For each={p.doc.questions}>
            {(q, i) => {
              const edit: EditQ = (f, key) => p.update((d) => { const x = d.questions[i()]; if (x !== undefined) f(x); }, key === undefined ? undefined : `${q.id}:${key}`);
              return (
                <tr>
                  <td class="q-mono">{i() + 1}</td>
                  <td class="s-col-q">
                    <span class="s-kind">{kindLabel(q.answerSpec.kind)}</span>
                    <textarea rows={2} value={q.prompt.text} onInput={(e) => { const v = e.currentTarget.value; edit((x) => { x.prompt.text = v; }, "text"); }} />
                    <p class="muted s-hint">{roundsOf(p.doc, q.id).join(" · ") || "dans aucune manche"}</p>
                    <For each={p.doc.format.rounds.filter((r) => r.questions.includes(q.id) || r.reserve.includes(q.id))}>
                      {(r) => { const w = () => pointsInfo(r, q, defaultRegistry); return <p class="s-worth-line" title="Priorité : points de la question, sinon barème de sa catégorie, sinon barème de la manche (onglet Format)">Vaut <b>{w().summary}</b> <span class="muted">· {w().why}{p.doc.format.rounds.length > 1 ? ` · ${r.title}` : ""}</span></p>; }}
                    </For>
                    <For each={issuesByQuestion().get(q.id) ?? []}>{(w) => <p class="s-warn-text">⚠ question incompatible : {w}</p>}</For>
                  </td>
                  <td class="s-col-a"><AnswerEditor q={q} edit={edit} /></td>
                  <td><MediaCell q={q} edit={edit} /></td>
                  <td class="s-col-meta">
                    <label class="s-field"><span class="s-label">Indices (un par ligne)</span><textarea rows={2} value={q.hints.join("\n")} onChange={(e) => { const v = splitList(e.currentTarget.value, /\n/); edit((x) => { x.hints = v; }); }} /></label>
                    <label class="s-field"><span class="s-label">Catégories (la 1re = colonne du plateau)</span><input value={q.tags.join(", ")} onChange={(e) => { const v = splitList(e.currentTarget.value, /,/); edit((x) => { x.tags = v; }); }} /></label>
                    <label class="s-field"><span class="s-label">Notes animateur</span><textarea rows={2} value={q.notes ?? ""} onInput={(e) => { const v = e.currentTarget.value; edit((x) => { if (v === "") delete x.notes; else x.notes = v; }, "notes"); }} /></label>
                    <QuestionPointsField q={q} edit={edit} />
                  </td>
                  <td class="s-actions">
                    <Button kind="ghost" title="Monter" disabled={i() === 0} onClick={() => p.update((d) => moveItem(d.questions, i(), i() - 1))}>↑</Button>
                    <Button kind="ghost" title="Descendre" disabled={i() === p.doc.questions.length - 1} onClick={() => p.update((d) => moveItem(d.questions, i(), i() + 1))}>↓</Button>
                    <Button kind="ghost" title="Supprimer la question" disabled={p.doc.questions.length <= 1} onClick={() => void remove(q)}>✕</Button>
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <Panel title="Coller depuis Excel / Sheets / CSV (type ; question ; A … F ; réponse ; notes)">
        <textarea class="s-paste" rows={4} value={paste()} onInput={(e) => setPaste(e.currentTarget.value)} />
        <div class="s-toolbar">
          <Button disabled={pasted().questions.length === 0} onClick={importPaste}>Ajouter {pasted().questions.length} question(s){targetTitle() === null ? "" : ` à « ${targetTitle() ?? ""} »`}</Button>
          <Show when={pasted().errors.length > 0}><span class="s-bad">{pasted().errors.slice(0, 3).join(" · ")}</span></Show>
        </div>
      </Panel>
    </div>
  );
}

function MediaCell(p: { q: Question; edit: EditQ }): JSX.Element {
  const attach = async (f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    p.edit((x) => { x.prompt.media = m; });
  };
  return (
    <Show when={p.q.prompt.media} fallback={<label class="q-btn q-btn-ghost s-file">Ajouter<input type="file" accept="image/*,video/*,audio/*" onChange={(e) => void attach(e.currentTarget.files?.[0])} /></label>}>
      {(m) => (
        <div class="s-media">
          <Show when={m().mime.startsWith("image/")} fallback={<span>{m().mime.split("/")[0] === "audio" ? "son" : "vidéo"}</span>}><img src={mediaUrl(m().hash)} alt="" /></Show>
          <Button kind="ghost" onClick={() => p.edit((x) => { delete x.prompt.media; })}>retirer</Button>
        </div>
      )}
    </Show>
  );
}

/** Editor of the answer, per kind. */
function AnswerEditor(p: { q: Question; edit: EditQ }): JSX.Element {
  const spec = <K extends AnswerKind>(k: K, f: (s: SpecOf<K>) => void, key?: string) => p.edit((x) => { if (isKind(x.answerSpec, k)) f(x.answerSpec); }, key);
  const a = () => p.q.answerSpec;
  /** The answer spec when it is of kind `k` (Match then hands a narrowed accessor). */
  const as = <K extends AnswerKind>(k: K): SpecOf<K> | false => {
    const x = p.q.answerSpec;
    return isKind(x, k) ? x : false;
  };
  return (
    <Switch>
      <Match when={as("boolean")}>
        {(s) => (
          <div class="s-row">
            <label><input type="radio" checked={s().correct} onChange={() => spec("boolean", (x) => { x.correct = true; })} /> Vrai</label>
            <label><input type="radio" checked={!s().correct} onChange={() => spec("boolean", (x) => { x.correct = false; })} /> Faux</label>
          </div>
        )}
      </Match>
      <Match when={a().kind === "single" || a().kind === "multi"}>
        <ChoiceEditor q={p.q} edit={p.edit} />
      </Match>
      <Match when={as("text")}>
        {(t) => {
          return (
            <div class="s-opts">
              <span class="s-label">Réponses acceptées (la 1re est affichée)</span>
              <For each={t().accepted}>
                {(v, vi) => (
                  <div class="s-opt">
                    <input value={v} onInput={(e) => { const val = e.currentTarget.value; spec("text", (x) => { x.accepted[vi()] = val; }, `acc${vi()}`); }} />
                    <Button kind="ghost" title="Retirer" disabled={t().accepted.length <= 1} onClick={() => spec("text", (x) => { x.accepted.splice(vi(), 1); })}>✕</Button>
                  </div>
                )}
              </For>
              <Button kind="ghost" onClick={() => spec("text", (x) => { x.accepted.push("Variante"); })}>+ variante acceptée</Button>
              <label class="s-inline">Fautes tolérées
                <select value={t().maxDistance === undefined ? "auto" : String(t().maxDistance)} onChange={(e) => { const v = e.currentTarget.value; spec("text", (x) => { if (v === "auto") delete x.maxDistance; else x.maxDistance = Number(v); }); }}>
                  <option value="auto">auto (selon la longueur)</option>
                  <option value="0">aucune</option>
                  <option value="1">1 lettre</option>
                  <option value="2">2 lettres</option>
                  <option value="3">3 lettres</option>
                </select>
              </label>
            </div>
          );
        }}
      </Match>
      <Match when={as("number")}>
        {(n) => {
          return (
            <div class="s-grid2">
              <label class="s-field"><span class="s-label">Bonne réponse</span><NumField step={0.01} value={n().correct} onChange={(v) => spec("number", (x) => { x.correct = v; })} /></label>
              <label class="s-field"><span class="s-label">Tolérance ±</span><NumField min={0} step={0.01} value={n().tolerance} onChange={(v) => spec("number", (x) => { x.tolerance = Math.max(0, v); })} onEmpty={() => spec("number", (x) => { x.tolerance = 0; })} /></label>
              <label class="s-field"><span class="s-label">Unité</span><input value={n().unit ?? ""} placeholder="km, €, ans…" onChange={(e) => { const v = e.currentTarget.value.trim(); spec("number", (x) => { if (v === "") delete x.unit; else x.unit = v; }); }} /></label>
              <span />
              <label class="s-field"><span class="s-label">Minimum saisi</span><NumField step={0.01} value={n().min} placeholder="aucun" onChange={(v) => spec("number", (x) => { x.min = v; })} onEmpty={() => spec("number", (x) => { delete x.min; })} /></label>
              <label class="s-field"><span class="s-label">Maximum saisi</span><NumField step={0.01} value={n().max} placeholder="aucun" onChange={(v) => spec("number", (x) => { x.max = v; })} onEmpty={() => spec("number", (x) => { delete x.max; })} /></label>
            </div>
          );
        }}
      </Match>
      <Match when={as("order")}>
        {(o) => {
          return (
            <div class="s-opts">
              <span class="s-label">Dans le bon ordre (mélangés à l'écran)</span>
              <For each={o().options}>
                {(opt, oi) => (
                  <div class="s-opt">
                    <span class="q-mono muted">{oi() + 1}</span>
                    <input value={opt.label} onInput={(e) => { const v = e.currentTarget.value; spec("order", (x) => { const it = x.options[oi()]; if (it !== undefined) it.label = v; }, `o${oi()}`); }} />
                    <Button kind="ghost" title="Monter" disabled={oi() === 0} onClick={() => spec("order", (x) => moveItem(x.options, oi(), oi() - 1))}>↑</Button>
                    <Button kind="ghost" title="Descendre" disabled={oi() === o().options.length - 1} onClick={() => spec("order", (x) => moveItem(x.options, oi(), oi() + 1))}>↓</Button>
                    <Button kind="ghost" title="Retirer" disabled={o().options.length <= 3} onClick={() => spec("order", (x) => { x.options.splice(oi(), 1); })}>✕</Button>
                  </div>
                )}
              </For>
              <Show when={o().options.length < 8}><Button kind="ghost" onClick={() => spec("order", (x) => { x.options.push({ id: freeOptionId(x.options.map((y) => y.id)), label: `Élément ${x.options.length + 1}` }); })}>+ élément</Button></Show>
            </div>
          );
        }}
      </Match>
      <Match when={as("pairs")}>
        {(pr) => {
          return (
            <div class="s-opts">
              <span class="s-label">Gauche → droite (la colonne de droite est mélangée)</span>
              <For each={pr().pairs}>
                {(pair, pi) => (
                  <div class="s-opt">
                    <input value={pair.left} onInput={(e) => { const v = e.currentTarget.value; spec("pairs", (x) => { const it = x.pairs[pi()]; if (it !== undefined) it.left = v; }, `l${pi()}`); }} />
                    <span class="muted">→</span>
                    <input value={pair.right} onInput={(e) => { const v = e.currentTarget.value; spec("pairs", (x) => { const it = x.pairs[pi()]; if (it !== undefined) it.right = v; }, `r${pi()}`); }} />
                    <Button kind="ghost" title="Retirer" disabled={pr().pairs.length <= 2} onClick={() => spec("pairs", (x) => { x.pairs.splice(pi(), 1); })}>✕</Button>
                  </div>
                )}
              </For>
              <Show when={pr().pairs.length < 8}><Button kind="ghost" onClick={() => spec("pairs", (x) => { const n = x.pairs.length + 1; x.pairs.push({ id: freeOptionId(x.pairs.map((y) => y.id)), left: `Gauche ${n}`, right: `Droite ${n}` }); })}>+ paire</Button></Show>
            </div>
          );
        }}
      </Match>
      <Match when={as("pin")}>
        {(s) => {
          return <PinEditor q={p.q} target={s().target} setTarget={(r, key) => spec("pin", (x) => { x.target = r; }, key)} edit={p.edit} />;
        }}
      </Match>
      <Match when={as("allocation")}>
        {(al) => {
          return (
            <div class="s-opts">
              <label class="s-inline">Mise de départ <NumField min={1} value={al().budget} onChange={(v) => spec("allocation", (x) => { x.budget = Math.max(1, Math.round(v)); })} /></label>
              <span class="s-label">Réponses (cocher la bonne)</span>
              <For each={al().options}>
                {(opt, oi) => (
                  <div class="s-opt">
                    <input type="radio" name={`alloc-${p.q.id}`} title="bonne réponse" checked={al().correct === opt.id} onChange={() => spec("allocation", (x) => { x.correct = opt.id; })} />
                    <input value={opt.label} onInput={(e) => { const v = e.currentTarget.value; spec("allocation", (x) => { const it = x.options[oi()]; if (it !== undefined) it.label = v; }, `o${oi()}`); }} />
                    <Button kind="ghost" title="Retirer" disabled={al().options.length <= 2} onClick={() => spec("allocation", (x) => { const [gone] = x.options.splice(oi(), 1); if (gone?.id === x.correct) x.correct = x.options[0]?.id ?? x.correct; })}>✕</Button>
                  </div>
                )}
              </For>
              <Show when={al().options.length < 6}><Button kind="ghost" onClick={() => spec("allocation", (x) => { const id = freeOptionId(x.options.map((y) => y.id)); x.options.push({ id, label: `Réponse ${id.toUpperCase()}` }); })}>+ réponse</Button></Show>
            </div>
          );
        }}
      </Match>
      <Match when={as("oral")}>
        {(s) => (
          <label class="s-field"><span class="s-label">Réponse attendue (vue animateur et régie)</span>
            <input value={s().expected} onInput={(e) => { const v = e.currentTarget.value; spec("oral", (x) => { x.expected = v; }, "expected"); }} />
          </label>
        )}
      </Match>
      <Match when={as("poll")}>
        {(po) => {
          const total = () => po().options.reduce((t, o) => t + (o.value ?? 0), 0);
          return (
            <div class="s-opts">
              <span class="s-label">Réponses du sondage et leur %</span>
              <For each={po().options}>
                {(opt, oi) => (
                  <div class="s-opt">
                    <input value={opt.label} onInput={(e) => { const v = e.currentTarget.value; spec("poll", (x) => { const it = x.options[oi()]; if (it !== undefined) it.label = v; }, `o${oi()}`); }} />
                    <NumField min={0} max={100} value={opt.value} title="%" onChange={(v) => spec("poll", (x) => { const it = x.options[oi()]; if (it !== undefined) it.value = v; })} />
                    <span class="muted">%</span>
                    <Button kind="ghost" title="Retirer" disabled={po().options.length <= 1} onClick={() => spec("poll", (x) => { x.options.splice(oi(), 1); })}>✕</Button>
                  </div>
                )}
              </For>
              <div class="s-row">
                <Show when={po().options.length < 12}><Button kind="ghost" onClick={() => spec("poll", (x) => { x.options.push({ id: freeOptionId(x.options.map((y) => y.id)), label: `Réponse ${x.options.length + 1}`, value: 0 }); })}>+ réponse</Button></Show>
                <span class="muted q-mono" data-bad={String(total() > 100)}>total {total()} %</span>
              </div>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function ChoiceEditor(p: { q: Question; edit: EditQ }): JSX.Element {
  const opts = () => ("options" in p.q.answerSpec ? p.q.answerSpec.options : []);
  const isCorrect = (id: string) => (p.q.answerSpec.kind === "single" ? p.q.answerSpec.correct === id : p.q.answerSpec.kind === "multi" && p.q.answerSpec.correct.includes(id));
  return (
    <div class="s-opts">
      <For each={opts()}>
        {(o, oi) => (
          <div class="s-opt">
            <input type="checkbox" checked={isCorrect(o.id)} title="bonne réponse" onChange={(e) => {
              const on = e.currentTarget.checked;
              p.edit((x) => {
                const s = x.answerSpec;
                if (s.kind === "single") {
                  if (on) s.correct = o.id;
                } else if (s.kind === "multi") {
                  const next = on ? [...new Set([...s.correct, o.id])] : s.correct.filter((c) => c !== o.id);
                  if (next.length > 0) s.correct = next;
                }
              });
            }} />
            <input value={o.label} onInput={(e) => { const v = e.currentTarget.value; p.edit((x) => { const s = x.answerSpec; if (s.kind === "single" || s.kind === "multi") { const it = s.options[oi()]; if (it !== undefined) it.label = v; } }, `o${oi()}`); }} />
            <Button kind="ghost" title="Retirer" disabled={opts().length <= 2} onClick={() => p.edit((x) => {
              const s = x.answerSpec;
              if (s.kind !== "single" && s.kind !== "multi") return;
              const [gone] = s.options.splice(oi(), 1);
              if (s.kind === "single" && gone?.id === s.correct) s.correct = s.options[0]?.id ?? s.correct;
              if (s.kind === "multi") {
                const left = s.correct.filter((c) => c !== gone?.id);
                s.correct = left.length > 0 ? left : [s.options[0]?.id ?? "a"];
              }
            })}>✕</Button>
          </div>
        )}
      </For>
      <Show when={opts().length < 6}>
        <Button kind="ghost" onClick={() => p.edit((x) => { const s = x.answerSpec; if (s.kind === "single" || s.kind === "multi") { const id = freeOptionId(s.options.map((y) => y.id)); s.options.push({ id, label: `Réponse ${id.toUpperCase()}` }); } })}>+ réponse</Button>
      </Show>
      <label class="muted"><input type="checkbox" checked={p.q.answerSpec.kind === "multi"} onChange={(e) => {
        const on = e.currentTarget.checked;
        p.edit((x) => {
          const s = x.answerSpec;
          if (s.kind !== "single" && s.kind !== "multi") return;
          const options = s.options;
          x.answerSpec = on
            ? { kind: "multi", options, correct: [s.kind === "single" ? s.correct : (options[0]?.id ?? "a")] }
            : { kind: "single", options, correct: s.kind === "multi" ? (s.correct[0] ?? "a") : "a" };
        });
      }} /> plusieurs bonnes réponses</label>
    </div>
  );
}

const pct = (v: number): number => Math.round(v * 1000) / 10;

/** Pin target: drag on the image preview, or type x / y / w / h in % of the image. */
function PinEditor(p: { q: Question; target: NormRect | null; setTarget: (r: NormRect, key?: string) => void; edit: EditQ }): JSX.Element {
  let box: HTMLDivElement | undefined;
  const [drag, setDrag] = createSignal<NormRect | null>(null);
  const norm = (e: PointerEvent): { x: number; y: number } => {
    const r = box?.getBoundingClientRect();
    return r === undefined || r.width === 0 || r.height === 0 ? { x: 0, y: 0 } : { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const a = norm(e);
    const move = (ev: PointerEvent) => setDrag(normRectFromDrag(a, norm(ev)));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      p.setTarget(normRectFromDrag(a, norm(ev)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const attach = async (f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    p.edit((x) => { x.prompt.media = m; });
  };
  const shown = () => drag() ?? p.target;
  const setField = (k: keyof NormRect, v: number) => {
    const t = p.target;
    if (t === null) return;
    const next = { ...t, [k]: Math.min(1, Math.max(k === "w" || k === "h" ? 0.01 : 0, v / 100)) };
    next.x = Math.min(next.x, 1 - next.w);
    next.y = Math.min(next.y, 1 - next.h);
    p.setTarget(next);
  };
  return (
    <div class="s-opts">
      <Show when={p.q.prompt.media?.mime.startsWith("image/") === true ? p.q.prompt.media : undefined} fallback={
        <div class="s-stack">
          <p class="s-warn-text">Il faut une image : c'est sur elle que les joueurs posent leur point.</p>
          <label class="q-btn q-btn-secondary s-file">Choisir l'image…<input type="file" accept="image/*" onChange={(e) => void attach(e.currentTarget.files?.[0])} /></label>
        </div>
      }>
        {(m) => (
          <>
            <span class="s-label">Glisser sur l'image pour placer la zone juste</span>
            <div ref={box} class="s-pin" onPointerDown={down}>
              <img src={mediaUrl(m().hash)} alt="" draggable={false} />
              <Show when={shown()}>{(t) => <div class="s-pin-target" style={{ left: `${t().x * 100}%`, top: `${t().y * 100}%`, width: `${t().w * 100}%`, height: `${t().h * 100}%` }} />}</Show>
            </div>
          </>
        )}
      </Show>
      <Show when={p.target}>
        {(t) => (
          <div class="s-grid4">
            <For each={[["x", "X"], ["y", "Y"], ["w", "Largeur"], ["h", "Hauteur"]] as const}>
              {([k, label]) => <label class="s-field"><span class="s-label">{label} %</span><NumField min={0} max={100} step={0.1} value={pct(t()[k])} onChange={(v) => setField(k, v)} /></label>}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * Points of this question: the barème (round / category) by default, or its own — fixed points, or a decay from a
 * maximum to a minimum over the answer time. Wins over the round and category rules.
 */
const fixedOf = (p: QuestionPoints): { points: number } | null => (p.mode === "fixed" ? p : null);
const decayOf = (p: QuestionPoints): { max: number; min: number } | null => (p.mode === "decay" ? p : null);

function QuestionPointsField(p: { q: Question; edit: (f: (x: Question) => void, key?: string) => void }): JSX.Element {
  const cur = () => questionPoints(p.q);
  const set = (next: QuestionPoints) => p.edit((x) => { const r = pointsRule(next, x.scoring); if (r === undefined) delete x.scoring; else x.scoring = r; }, "points");
  return (
    <div class="s-field s-points">
      <span class="s-label" title="Les points de la question passent avant le barème de sa catégorie et celui de la manche (onglet Format). La mise en direct de la régie s'applique par-dessus.">Points de cette question</span>
      <select value={cur().mode} onChange={(e) => {
        const m = e.currentTarget.value;
        if (m === "round") set({ mode: "round" });
        else if (m === "fixed") set({ mode: "fixed", points: 100 });
        else if (m === "decay") set({ mode: "decay", max: 100, min: 50 });
      }}>
        <option value="round">selon le barème (catégorie, sinon manche)</option>
        <option value="fixed">points fixes</option>
        <option value="decay">dégressif (plus on répond vite, plus on marque)</option>
        <Show when={cur().mode === "custom"}><option value="custom">règle personnalisée (JSON)</option></Show>
      </select>
      <Show when={fixedOf(cur())}>
        {(c) => <label class="s-inline"><NumField min={-1_000_000} max={1_000_000} step={10} value={c().points} onChange={(v) => set({ mode: "fixed", points: v })} /> points</label>}
      </Show>
      <Show when={decayOf(cur())}>
        {(d) => (
          <span class="s-inline">
            de <NumField min={0} max={1_000_000} step={10} value={d().max} onChange={(v) => set({ mode: "decay", max: v, min: d().min })} /> à <NumField min={0} max={1_000_000} step={10} value={d().min} onChange={(v) => set({ mode: "decay", max: d().max, min: v })} /> points
          </span>
        )}
      </Show>
    </div>
  );
}

