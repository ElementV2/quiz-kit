import { For, Show, type JSX } from "solid-js";
import { answerText, asAllocation, asBoard, asHints, asNumberAnswer, asPin, asRevealImage, asTextAnswer, boardRows, correctText, formatNumber, nameOf } from "@quiz/renderer";
import type { Action, ControlView, HostView, MechanicView } from "@quiz/schema";
import { Button } from "./components.tsx";

/**
 * Control room / host panels of the phase 3 mechanics (doc 08 « actions contextuelles »). Buttons only send
 * intents: verdicts, points and the next step are decided by the engine and come back in the view.
 */

type Props = {
  readonly view: ControlView | HostView;
  readonly mode: "control" | "host";
  readonly act: (a: Action, okText?: string) => Promise<boolean>;
  readonly mediaUrl: (hash: string) => string;
};

const JUDGEABLE = new Set(["open", "locked", "judging"]);
const judgeable = (v: ControlView | HostView): boolean => JUDGEABLE.has(v.phase);

/** Mechanics whose automatic verdict the operator may overrule (`answer.judge { participantId, correct }`). */
const OVERRULABLE = new Set(["text-answer", "number-answer", "order", "pairs", "pin", "hints", "reveal-image"]);

const answeredOf = (m: MechanicView): number | null => ("answeredCount" in m ? m.answeredCount : null);

/** Right answer + answers received: shown for every phase 3 mechanic. */
function Summary(p: Props & { readonly m: MechanicView }): JSX.Element {
  const players = () => (p.view.role === "control" ? p.view.participants.length : null);
  return (
    <>
      <Show when={correctText(p.m)}>{(c) => <p class="q-mech-ok">Bonne réponse : {c()}</p>}</Show>
      <Show when={answeredOf(p.m) !== null}>
        <p class="muted q-mech-count">{answeredOf(p.m)} réponse(s){players() === null ? "" : ` · ${players()} joueur(s)`}</p>
      </Show>
    </>
  );
}

function Verdict(p: Props & { readonly participantId: string; readonly accepted: boolean | null }): JSX.Element {
  return (
    <span class="q-mech-verdict">
      <button type="button" class="q-toggle" data-on={String(p.accepted === true)} disabled={!judgeable(p.view)} title="Compter juste" onClick={() => void p.act({ type: "answer.judge", participantId: p.participantId, correct: true })}>✓</button>
      <button type="button" class="q-toggle q-toggle-no" data-on={String(p.accepted === false)} disabled={!judgeable(p.view)} title="Compter faux" onClick={() => void p.act({ type: "answer.judge", participantId: p.participantId, correct: false })}>✗</button>
    </span>
  );
}

/** Text answers with their automatic verdict (host and control): ✓ / ✗ overrules it before the reveal. */
function TextReview(p: Props): JSX.Element {
  return (
    <Show when={asTextAnswer(p.view.mechanic)?.review}>
      {(review) => (
        <ul class="q-mech-review">
          <For each={review()} fallback={<li class="muted">Aucune réponse pour l'instant.</li>}>
            {(r) => (
              <li data-accepted={String(r.accepted)}>
                <span class="q-mech-who">{nameOf(p.view, r.participantId)}</span>
                <span class="q-mech-said">{r.text}</span>
                <Show when={r.overruled}><span class="q-mech-tag">corrigé</span></Show>
                <Verdict {...p} participantId={r.participantId} accepted={r.accepted} />
              </li>
            )}
          </For>
        </ul>
      )}
    </Show>
  );
}

/** Other overrulable mechanics: every answer received (control only) with ✓ / ✗ to force the verdict. */
function AnswersReview(p: Props & { readonly m: MechanicView }): JSX.Element {
  const answers = () => (p.view.role === "control" ? p.view.answers : []);
  const verdictOf = (pid: string): boolean | null => {
    const n = asNumberAnswer(p.m);
    return n?.ranking?.find((r) => r.participantId === pid)?.win ?? null;
  };
  return (
    <Show when={p.view.role === "control" && answers().length > 0}>
      <details class="q-mech-answers">
        <summary>Réponses reçues ({answers().length}) — corriger un verdict</summary>
        <ul class="q-mech-review">
          <For each={answers()}>
            {(a) => (
              <li data-accepted={String(verdictOf(a.participantId))}>
                <span class="q-mech-who">{nameOf(p.view, a.participantId)}</span>
                <span class="q-mech-said">{answerText(p.m, a.optionIds)}</span>
                <Verdict {...p} participantId={a.participantId} accepted={verdictOf(a.participantId)} />
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

function NumberRanking(p: Props): JSX.Element {
  return (
    <Show when={asNumberAnswer(p.view.mechanic)?.ranking}>
      {(ranking) => (
        <ol class="q-mech-slots">
          <For each={ranking()}>
            {(r) => (
              <li data-found={String(r.win)}>
                <span class="q-mech-slot-label">{nameOf(p.view, r.participantId)}</span>
                <span class="q-mech-wide">{formatNumber(r.value)} · écart {formatNumber(r.gap)}</span>
              </li>
            )}
          </For>
        </ol>
      )}
    </Show>
  );
}

function HintsControls(p: Props): JSX.Element {
  return (
    <Show when={asHints(p.view.mechanic)}>
      {(m) => (
        <div class="q-mech-hints">
          <p>Vaut maintenant <b>{m().points} pts</b> · indice {m().hintCount} / {m().total}</p>
          <ol class="q-mech-slots">
            <For each={m().hints}>{(h, i) => <li data-revealed={String(i() < m().hintCount)} data-found={String(i() < m().hintCount)}>{h}</li>}</For>
          </ol>
          <Show when={p.mode === "control"}>
            <Button disabled={m().hintCount >= m().total || p.view.phase === "revealed"} onClick={() => void p.act({ type: "element.reveal", index: m().hintCount })}>Indice suivant</Button>
          </Show>
        </div>
      )}
    </Show>
  );
}

function RevealImageControls(p: Props): JSX.Element {
  return (
    <Show when={asRevealImage(p.view.mechanic)}>
      {(m) => {
        const total = () => m().cols * m().rows;
        const shown = () => new Set(m().revealed);
        return (
          <div class="q-mech-hints">
            <p>Vaut maintenant <b>{m().points} pts</b> · {m().revealed.length} / {total()} cases dévoilées</p>
            <Show when={m().image}>
              {(img) => (
                <div class="q-mech-thumb">
                  <img src={p.mediaUrl(img().hash)} alt="" />
                  <div class="q-mech-tiles" style={{ "grid-template-columns": `repeat(${m().cols}, 1fr)`, "grid-template-rows": `repeat(${m().rows}, 1fr)` }}>
                    <For each={Array.from({ length: total() }, (_, i) => i)}>{(i) => <span data-revealed={String(shown().has(i))} />}</For>
                  </div>
                </div>
              )}
            </Show>
            <Show when={p.mode === "control"}>
              <Button disabled={m().revealed.length >= total() || p.view.phase === "revealed"} onClick={() => void p.act({ type: "element.reveal", index: m().revealed.length })}>Dévoiler une case</Button>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

function AllocationTotals(p: Props): JSX.Element {
  return (
    <Show when={asAllocation(p.view.mechanic)}>
      {(m) => (
        <ol class="q-mech-slots">
          <For each={m().options}>
            {(o) => (
              <li data-found={String(m().correct === o.id)}>
                <span class="q-mech-slot-label">{o.label}</span>
                <span class="q-mech-wide">{m().counts === null ? "" : formatNumber(m().counts?.[o.id] ?? 0)}</span>
              </li>
            )}
          </For>
        </ol>
      )}
    </Show>
  );
}

function PinSummary(p: Props): JSX.Element {
  return (
    <Show when={asPin(p.view.mechanic)?.pins}>
      {(pins) => <p>{pins().filter((x) => x.hit).length} / {pins().length} point(s) dans la zone</p>}
    </Show>
  );
}

/** Board: the grid (control picks a cell between two cells), then the hand to judge, like the buzzer. */
function BoardControls(p: Props): JSX.Element {
  return (
    <Show when={asBoard(p.view.mechanic)}>
      {(m) => (
        <div class="q-mech-board">
          <div class="q-board-pick" style={{ "grid-template-columns": `repeat(${Math.max(1, m().categories.length)}, 1fr)` }}>
            <For each={m().categories}>{(c) => <span class="q-board-pick-cat">{c.name}</span>}</For>
            <For each={boardRows(m())}>
              {(row) => (
                <For each={row}>
                  {(cell) => (
                    <Show when={cell} fallback={<span />}>
                      {(c) => (
                        <button
                          type="button"
                          class="q-board-pick-cell"
                          data-current={String(m().cell?.questionIndex === c().questionIndex)}
                          data-played={String(c().played)}
                          disabled={p.mode !== "control" || c().played || p.view.phase !== "idle"}
                          title={c().played ? "Case déjà jouée" : "Jouer cette case"}
                          onClick={() => void p.act({ type: "question.present", questionIndex: c().questionIndex })}
                        >
                          {formatNumber(c().value)}
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              )}
            </For>
          </div>
          <Show when={m().cell} fallback={<p class="muted">{p.mode === "control" ? "Choisissez une case pour la présenter." : "La régie choisit une case…"}</p>}>
            {(c) => <p>Case : <b>{c().category}</b> pour <b>{formatNumber(c().value)}</b></p>}
          </Show>
          <Show when={m().cell !== null}>
            <Show when={m().winner} fallback={
              <Show when={m().hand} fallback={<p class="muted">{p.view.phase === "open" ? "En attente d'un buzz…" : "Ouvrir les réponses pour activer les buzzers."}</p>}>
                {(h) => (
                  <>
                    <p class="q-mech-hand">Main : <b>{nameOf(p.view, h())}</b></p>
                    <div class="q-mech-row">
                      <Button onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: true })}>✓ Bonne réponse</Button>
                      <Button kind="danger" onClick={() => void p.act({ type: "answer.judge", participantId: h(), correct: false })}>✗ Faux</Button>
                    </div>
                  </>
                )}
              </Show>
            }>
              {(w) => <p class="q-mech-ok">✓ {nameOf(p.view, w())} a trouvé</p>}
            </Show>
            <Show when={(m().queue ?? []).length > 0}><p class="muted">File : {(m().queue ?? []).map((id) => nameOf(p.view, id)).join(" → ")}</p></Show>
            <Show when={(m().lockedOut ?? []).length > 0}><p class="muted">Bloqués : {(m().lockedOut ?? []).map((id) => nameOf(p.view, id)).join(", ")}</p></Show>
          </Show>
        </div>
      )}
    </Show>
  );
}

const PHASE3 = new Set(["text-answer", "number-answer", "order", "pairs", "pin", "allocation", "board", "hints", "reveal-image"]);

export function Phase3Panel(p: Props): JSX.Element {
  return (
    <Show when={p.view.mechanic !== null && PHASE3.has(p.view.mechanic.mechanic) ? p.view.mechanic : null}>
      {(m) => (
        <div class="q-mech-p3" data-mechanic={m().mechanic}>
          <Show when={m().mechanic !== "board"}><Summary {...p} m={m()} /></Show>
          <BoardControls {...p} />
          <HintsControls {...p} />
          <RevealImageControls {...p} />
          <NumberRanking {...p} />
          <AllocationTotals {...p} />
          <PinSummary {...p} />
          <TextReview {...p} />
          <Show when={OVERRULABLE.has(m().mechanic) && m().mechanic !== "text-answer"}><AnswersReview {...p} m={m()} /></Show>
          <Show when={m().mechanic === "board"}><Show when={correctText(m())}>{(c) => <p class="q-mech-ok">Réponse attendue : {c()}</p>}</Show></Show>
        </div>
      )}
    </Show>
  );
}
