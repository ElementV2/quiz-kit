import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from "solid-js";
import { answerText, asAllocation, asBoard, asBuzzer, asHints, asNumberAnswer, asOrder, asPairs, asPin, asRevealImage, asTextAnswer, correctText, formatNumber, nameOf, optionLetter, optionState, parsePin, type PinView, type RevealImageView } from "@quiz/renderer";
import type { AnswerValue, PlayerView } from "@quiz/schema";
import { allocAdjust, allocAllIn, allocProblem, allocRemaining, allocStep, initialOrder, keypadPress, linkPair, linksFrom, moveItem, normPoint, numberProblem, pairsComplete, parseDecimal, unlinkRight } from "./inputs-logic.ts";

/**
 * Tablet inputs of the phase 3 mechanics (big touch targets, no drag-only gesture). Each one builds a draft
 * locally and sends ONE intent; "Réponse enregistrée" only shows once the server view carries the answer.
 * Mounted per question (keyed by question id), so a draft never leaks to the next question.
 */

export type InputProps = {
  readonly view: PlayerView;
  /** Sends `answer.submit`; resolves once acked (or refused). */
  readonly send: (answer: AnswerValue) => Promise<void>;
  readonly sending: boolean;
  readonly mediaUrl: (hash: string) => string;
  readonly buzz: () => Promise<void>;
  readonly buzzing: boolean;
};

const locked = (p: InputProps): boolean => !p.view.canAnswer || p.sending;
const isRevealed = (p: InputProps): boolean => p.view.phase === "revealed";

/** After the reveal: the right answer and the player's own answer, in words. */
function Recap(p: { readonly view: PlayerView }): JSX.Element {
  const right = () => correctText(p.view.mechanic);
  const mine = () => answerText(p.view.mechanic, p.view.myAnswer);
  return (
    <Show when={p.view.phase === "revealed"}>
      <div class="p-recap">
        <Show when={right()}>{(r) => <p class="p-recap-right">Bonne réponse : <b>{r()}</b></p>}</Show>
        <Show when={mine() !== ""}><p class="muted">Votre réponse : {mine()}</p></Show>
      </div>
    </Show>
  );
}

function TextInput(p: InputProps & { readonly placeholder?: string }): JSX.Element {
  const [text, setText] = createSignal(p.view.myAnswer?.[0] ?? "");
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const t = text().trim();
    if (t.length > 0 && !locked(p)) void p.send({ kind: "text", text: t });
  };
  return (
    <form class="p-text" onSubmit={submit}>
      <input class="p-input" type="text" autocomplete="off" autocapitalize="off" spellcheck={false} maxlength={200} placeholder={p.placeholder ?? "Votre réponse"} value={text()} disabled={!p.view.canAnswer} onInput={(e) => setText(e.currentTarget.value)} />
      <button class="q-btn q-btn-big" type="submit" disabled={locked(p) || text().trim().length === 0}>Envoyer</button>
    </form>
  );
}

const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ",", "0", "⌫"] as const;

function NumberInput(p: InputProps): JSX.Element {
  const m = () => asNumberAnswer(p.view.mechanic);
  const [draft, setDraft] = createSignal((p.view.myAnswer?.[0] ?? "").replace(".", ","));
  const value = () => parseDecimal(draft());
  const problem = () => numberProblem(value(), m()?.min ?? null, m()?.max ?? null);
  const negative = () => {
    const min = m()?.min ?? null;
    return min === null || min < 0;
  };
  const range = () => {
    const mm = m();
    if (mm === null || (mm.min === null && mm.max === null)) return "";
    if (mm.min !== null && mm.max !== null) return `entre ${formatNumber(mm.min)} et ${formatNumber(mm.max)}`;
    return mm.min !== null ? `au moins ${formatNumber(mm.min)}` : `au plus ${formatNumber(mm.max ?? 0)}`;
  };
  const send = () => {
    const v = value();
    if (v !== null && problem() === null && !locked(p)) void p.send({ kind: "number", value: v });
  };
  return (
    <div class="p-number">
      <div class="p-number-display" data-empty={String(draft() === "")}>
        <span>{draft() === "" ? "—" : draft()}</span>
        <Show when={m()?.unit}>{(u) => <span class="p-unit">{u()}</span>}</Show>
      </div>
      <Show when={range() !== ""}><p class="muted p-hint">Nombre {range()}</p></Show>
      <div class="p-keypad">
        <For each={KEYS}>{(k) => <button type="button" class="p-key" disabled={!p.view.canAnswer} onClick={() => setDraft(keypadPress(draft(), k))}>{k}</button>}</For>
        <Show when={negative()}><button type="button" class="p-key p-key-wide" disabled={!p.view.canAnswer} onClick={() => setDraft(keypadPress(draft(), "−"))}>± signe</button></Show>
      </div>
      <button type="button" class="q-btn q-btn-big" disabled={locked(p) || problem() !== null} onClick={send}>Envoyer</button>
      <Show when={draft() !== "" && problem()}>{(pb) => <p class="p-warn">{pb()}</p>}</Show>
    </div>
  );
}

function OrderInput(p: InputProps): JSX.Element {
  const m = () => asOrder(p.view.mechanic);
  const [order, setOrder] = createSignal(initialOrder((m()?.options ?? []).map((o) => o.id), p.view.myAnswer));
  const label = (id: string) => m()?.options.find((o) => o.id === id)?.label ?? id;
  const send = () => {
    if (!locked(p)) void p.send({ kind: "order", optionIds: order() });
  };
  return (
    <div class="p-order">
      <ol class="p-order-list">
        <For each={order()}>
          {(id, i) => (
            <li class="p-order-item">
              <span class="p-letter">{i() + 1}</span>
              <span class="p-label">{label(id)}</span>
              <button type="button" class="p-move" aria-label="Monter" disabled={!p.view.canAnswer || i() === 0} onClick={() => setOrder(moveItem(order(), i(), -1))}>▲</button>
              <button type="button" class="p-move" aria-label="Descendre" disabled={!p.view.canAnswer || i() === order().length - 1} onClick={() => setOrder(moveItem(order(), i(), 1))}>▼</button>
            </li>
          )}
        </For>
      </ol>
      <button type="button" class="q-btn q-btn-big" disabled={locked(p)} onClick={send}>Valider cet ordre</button>
    </div>
  );
}

function PairsInput(p: InputProps): JSX.Element {
  const m = () => asPairs(p.view.mechanic);
  const [links, setLinks] = createSignal<Record<string, string>>(linksFrom(p.view.myAnswer));
  const [picked, setPicked] = createSignal<string | null>(null);
  const leftIds = () => (m()?.left ?? []).map((l) => l.id);
  const letterOfLeft = (id: string) => optionLetter(leftIds().indexOf(id));
  const leftOfRight = (rid: string) => Object.entries(links()).find(([, r]) => r === rid)?.[0] ?? null;
  const tapRight = (rid: string) => {
    const l = picked();
    if (l !== null) {
      setLinks(linkPair(links(), l, rid));
      setPicked(null);
    } else if (leftOfRight(rid) !== null) setLinks(unlinkRight(links(), rid));
  };
  const send = () => {
    if (locked(p) || !pairsComplete(links(), leftIds())) return;
    void p.send({ kind: "pairs", matches: leftIds().map((left) => ({ left, right: links()[left] ?? "" })) });
  };
  return (
    <div class="p-pairs">
      <p class="muted p-hint">Touchez un élément à gauche, puis son partenaire à droite.</p>
      <div class="p-pairs-cols">
        <div class="p-pairs-col">
          <For each={m()?.left ?? []}>
            {(l) => (
              <button type="button" class="p-pair" data-state={picked() === l.id ? "picked" : links()[l.id] !== undefined ? "linked" : "idle"} disabled={!p.view.canAnswer} onClick={() => setPicked(picked() === l.id ? null : l.id)}>
                <span class="p-tag">{letterOfLeft(l.id)}</span>
                <span class="p-label">{l.label}</span>
              </button>
            )}
          </For>
        </div>
        <div class="p-pairs-col">
          <For each={m()?.right ?? []}>
            {(r) => (
              <button type="button" class="p-pair" data-state={leftOfRight(r.id) !== null ? "linked" : "idle"} disabled={!p.view.canAnswer} onClick={() => tapRight(r.id)}>
                <span class="p-tag">{leftOfRight(r.id) === null ? "·" : letterOfLeft(leftOfRight(r.id) ?? "")}</span>
                <span class="p-label">{r.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="p-row">
        <button type="button" class="q-btn q-btn-secondary" disabled={!p.view.canAnswer || Object.keys(links()).length === 0} onClick={() => { setLinks({}); setPicked(null); }}>Tout effacer</button>
        <button type="button" class="q-btn q-btn-big p-grow" disabled={locked(p) || !pairsComplete(links(), leftIds())} onClick={send}>Valider les paires</button>
      </div>
    </div>
  );
}

function PinInput(p: InputProps): JSX.Element {
  const m = () => asPin(p.view.mechanic);
  const hash = () => m()?.image?.hash ?? p.view.question?.prompt.media?.hash ?? null;
  const [point, setPoint] = createSignal(parsePin(p.view.myAnswer));
  const tap = (e: MouseEvent & { currentTarget: HTMLImageElement }) => {
    if (!p.view.canAnswer) return;
    const pt = normPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    if (pt !== null) setPoint(pt);
  };
  const send = () => {
    const pt = point();
    if (pt !== null && !locked(p)) void p.send({ kind: "pin", x: pt.x, y: pt.y });
  };
  return (
    <div class="p-pin">
      <Show when={hash()} fallback={<p class="muted">Image indisponible : regardez l'écran.</p>}>
        {(h) => (
          <div class="p-pin-frame">
            <img src={p.mediaUrl(h())} alt="" draggable={false} onClick={tap} />
            <Show when={isRevealed(p) ? m()?.correct : null}>{(r) => <PinTarget r={r()} />}</Show>
            <Show when={point()}>{(pt) => <span class="p-pin-mark" style={{ left: `${pt().x * 100}%`, top: `${pt().y * 100}%` }} />}</Show>
          </div>
        )}
      </Show>
      <Show when={!isRevealed(p)}>
        <p class="muted p-hint">{point() === null ? "Touchez l'image à l'endroit choisi." : "Touchez ailleurs pour déplacer le repère."}</p>
        <button type="button" class="q-btn q-btn-big" disabled={locked(p) || point() === null} onClick={send}>Confirmer ce point</button>
      </Show>
    </div>
  );
}

function PinTarget(p: { readonly r: NonNullable<PinView["correct"]> }): JSX.Element {
  return <span class="p-pin-target" style={{ left: `${p.r.x * 100}%`, top: `${p.r.y * 100}%`, width: `${p.r.w * 100}%`, height: `${p.r.h * 100}%` }} />;
}

function AllocationInput(p: InputProps): JSX.Element {
  const m = () => asAllocation(p.view.mechanic);
  const budget = () => m()?.budget ?? 0;
  const ids = () => (m()?.options ?? []).map((o) => o.id);
  const initial = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of p.view.myAnswer ?? []) {
      const i = s.lastIndexOf(":");
      const n = Number(s.slice(i + 1));
      if (i > 0 && Number.isInteger(n)) out[s.slice(0, i)] = n;
    }
    return out;
  };
  const [amounts, setAmounts] = createSignal<Record<string, number>>(initial());
  const step = () => allocStep(budget());
  const rowState = (id: string) => {
    const mm = m();
    return mm !== null && isRevealed(p) ? optionState(mm, id, null, p.view.phase) : "idle";
  };
  const problem = () => allocProblem(amounts(), ids(), budget(), m()?.keepOneEmpty ?? true);
  const send = () => {
    if (locked(p) || problem() !== null) return;
    void p.send({ kind: "allocation", amounts: ids().map((optionId) => ({ optionId, amount: amounts()[optionId] ?? 0 })) });
  };
  return (
    <div class="p-alloc">
      <p class="p-alloc-left" data-zero={String(allocRemaining(amounts(), budget()) === 0)}>Restant : <b>{formatNumber(allocRemaining(amounts(), budget()))}</b> / {formatNumber(budget())}</p>
      <For each={m()?.options ?? []}>
        {(o, i) => (
          <div class="p-alloc-row" data-state={rowState(o.id)}>
            <span class="p-letter">{optionLetter(i())}</span>
            <span class="p-label">{o.label}</span>
            <button type="button" class="p-move" aria-label="Retirer" disabled={!p.view.canAnswer || (amounts()[o.id] ?? 0) === 0} onClick={() => setAmounts(allocAdjust(amounts(), o.id, -step(), budget()))}>−</button>
            <span class="p-amount">{formatNumber(amounts()[o.id] ?? 0)}</span>
            <button type="button" class="p-move" aria-label="Ajouter" disabled={!p.view.canAnswer || allocRemaining(amounts(), budget()) <= 0} onClick={() => setAmounts(allocAdjust(amounts(), o.id, step(), budget()))}>+</button>
            <button type="button" class="p-move p-move-wide" disabled={!p.view.canAnswer || allocRemaining(amounts(), budget()) <= 0} onClick={() => setAmounts(allocAllIn(amounts(), o.id, budget()))}>Tout</button>
          </div>
        )}
      </For>
      <Show when={!isRevealed(p)}>
        <div class="p-row">
          <button type="button" class="q-btn q-btn-secondary" disabled={!p.view.canAnswer} onClick={() => setAmounts({})}>Remettre à zéro</button>
          <button type="button" class="q-btn q-btn-big p-grow" disabled={locked(p) || problem() !== null} onClick={send}>Valider la répartition</button>
        </div>
        <Show when={problem()}>{(pb) => <p class="p-warn">{pb()}</p>}</Show>
      </Show>
    </div>
  );
}

/** Options of hints / reveal-image in `choice` mode: exactly one pick. */
function SingleChoice(p: InputProps & { readonly options: readonly { id: string; label: string }[] }): JSX.Element {
  return (
    <div class="p-options" data-count={p.options.length}>
      <For each={p.options}>
        {(o, i) => (
          <button type="button" class="p-option" data-state={p.view.mechanic === null ? "idle" : optionState(p.view.mechanic, o.id, p.view.myAnswer, p.view.phase)} disabled={locked(p)} onClick={() => void p.send({ kind: "choice", optionIds: [o.id] })}>
            <span class="p-letter">{optionLetter(i())}</span>
            <span class="p-label">{o.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * « Image dévoilée »: the same tiles as the screen. The tablet never gets the picture; each uncovered tile is cut and
 * served by the server (`/api/tile/<question>/<index>`), the others stay covered. Every tile once revealed.
 */
function TileGrid(p: { readonly questionId: string; readonly m: RevealImageView }): JSX.Element {
  const shown = () => new Set(p.m.revealed);
  const tiles = () => Array.from({ length: p.m.cols * p.m.rows }, (_, i) => i);
  const url = (i: number) => `/api/tile/${encodeURIComponent(p.questionId)}/${i}`;
  // The tiles are cut from the picture as the screen shows it (EXIF orientation applied): the first one that arrives
  // gives the true shape, the stored dimensions (`aspect`) only lay the grid out before.
  const [measured, setMeasured] = createSignal<number | null>(null);
  const measure = (e: Event) => {
    const img = e.currentTarget as HTMLImageElement; // oxlint-disable-line typescript/no-unsafe-type-assertion -- onLoad of an <img>
    if (img.naturalHeight > 0) setMeasured((img.naturalWidth * p.m.cols) / (img.naturalHeight * p.m.rows));
  };
  const aspect = () => String(measured() ?? p.m.aspect ?? 4 / 3);
  return (
    <div class="p-tiles" style={{ "aspect-ratio": aspect(), "--p-aspect": aspect(), "grid-template-columns": `repeat(${p.m.cols}, 1fr)`, "grid-template-rows": `repeat(${p.m.rows}, 1fr)` }}>
      <For each={tiles()}>
        {(i) => <div class="p-tile">{shown().has(i) ? <img src={url(i)} alt="" draggable={false} onLoad={measure} /> : null}</div>}
      </For>
    </div>
  );
}

/** Text or one option, for the progressive mechanics (hints, reveal-image). */
function ProgressiveAnswer(p: InputProps & { readonly input: "text" | "choice"; readonly options: readonly { id: string; label: string }[] | null }): JSX.Element {
  return (
    <Show when={p.input === "choice"} fallback={<Show when={!isRevealed(p)}><TextInput {...p} /></Show>}>
      <SingleChoice {...p} options={p.options ?? []} />
    </Show>
  );
}

/** Buzz button shared by the buzzer and the board (same `me` / `hand` / `winner` fields). */
export function BuzzPad(p: InputProps & { readonly m: { readonly winner: string | null; readonly hand: string | null; readonly me: { readonly hasHand: boolean; readonly queuePosition: number | null; readonly lockedOut: boolean; readonly canBuzz: boolean } | null } }): JSX.Element {
  const me = () => p.view.me?.participantId ?? null;
  return (
    <div class="p-buzz-wrap">
      <Switch>
        <Match when={p.m.winner !== null}><p class="p-big">{p.m.winner === me() ? "✓ Bravo !" : `✓ ${nameOf(p.view, p.m.winner)}`}</p></Match>
        <Match when={p.m.me?.hasHand === true}><p class="p-big p-hand">Vous avez la main : répondez !</p></Match>
        <Match when={p.m.me?.lockedOut === true}><p class="p-big muted">Bloqué pour cette question</p></Match>
        <Match when={p.m.me?.queuePosition !== null && p.m.me?.queuePosition !== undefined}><p class="p-big">En file : n° {p.m.me?.queuePosition ?? 0}</p></Match>
        <Match when={true}>
          <button type="button" class="p-buzz" disabled={!p.view.canAnswer || p.m.me?.canBuzz !== true || p.buzzing} onClick={() => void p.buzz()}>BUZZ</button>
        </Match>
      </Switch>
      <Show when={p.m.hand !== null && p.m.hand !== me() && p.m.winner === null}><p class="muted">Main : {nameOf(p.view, p.m.hand)}</p></Show>
    </div>
  );
}

/** The input of the current mechanic (phase 3 mechanics + buzzer); null view = nothing. */
export function MechanicInput(p: InputProps): JSX.Element {
  const kind = createMemo(() => p.view.mechanic?.mechanic ?? null);
  return (
    <Switch>
      <Match when={kind() === "buzzer" ? asBuzzer(p.view.mechanic) : null}>{(m) => <BuzzPad {...p} m={m()} />}</Match>
      <Match when={kind() === "board" ? asBoard(p.view.mechanic) : null}>
        {(m) => (
          <>
            <Show when={m().cell}>{(c) => <p class="p-cell">{c().category} · <b>{formatNumber(c().value)}</b></p>}</Show>
            <BuzzPad {...p} m={m()} />
            <Recap view={p.view} />
          </>
        )}
      </Match>
      <Match when={kind() === "text-answer" ? asTextAnswer(p.view.mechanic) : null}>
        <Show when={!isRevealed(p)}><TextInput {...p} /></Show>
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "number-answer"}>
        <Show when={!isRevealed(p)}><NumberInput {...p} /></Show>
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "order"}>
        <Show when={!isRevealed(p)}><OrderInput {...p} /></Show>
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "pairs"}>
        <Show when={!isRevealed(p)}><PairsInput {...p} /></Show>
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "pin"}>
        <PinInput {...p} />
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "allocation"}>
        <AllocationInput {...p} />
        <Recap view={p.view} />
      </Match>
      <Match when={kind() === "hints" ? asHints(p.view.mechanic) : null}>
        {(m) => (
          <>
            <ol class="p-hints">
              <For each={m().hints.slice(0, m().hintCount)}>{(h) => <li>{h}</li>}</For>
            </ol>
            <Show when={!isRevealed(p)}><p class="p-points">Une bonne réponse vaut maintenant <b>{m().points} pts</b></p></Show>
            <ProgressiveAnswer {...p} input={m().input} options={m().options} />
            <Recap view={p.view} />
          </>
        )}
      </Match>
      <Match when={kind() === "reveal-image" ? asRevealImage(p.view.mechanic) : null}>
        {(m) => (
          <>
            <Show when={p.view.question?.id} keyed>{(qid) => <TileGrid questionId={qid} m={m()} />}</Show>
            <Show when={!isRevealed(p)}>
              <p class="p-points">{m().revealed.length} / {m().cols * m().rows} cases dévoilées · vaut <b>{m().points} pts</b></p>
            </Show>
            <ProgressiveAnswer {...p} input={m().input} options={m().options} />
            <Recap view={p.view} />
          </>
        )}
      </Match>
    </Switch>
  );
}
