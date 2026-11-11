import { For, Match, Show, Switch, type JSX } from "solid-js";
import type { View } from "@quiz/schema";
import { boardRows, correctText, formatNumber } from "./answers.ts";
import { asBoard, asHints, asNumberAnswer, asOrder, asPairs, asPin, asRevealImage, nameOf, optionLetter, type BoardView, type PinView, type RevealImageView } from "./logic.ts";
import { FitText, panel, type ZoneProps } from "./zone-kit.tsx";

/**
 * On-air rendering of the phase 3 mechanics, plugged into the existing zone types (doc 06): `answer-list`
 * (order, pairs, number ranking, board grid, revealed answer) and `question-media` (pin, masked image, hints).
 * Cheap CSS only (OBS CPU): flat surfaces, opacity / background transitions, no filters.
 */

const isRevealed = (v: View): boolean => v.phase === "revealed";

const badge: JSX.CSSProperties = {
  "flex-shrink": 0,
  width: "52px",
  height: "52px",
  "border-radius": "50%",
  background: "var(--q-color-primary)",
  display: "grid",
  "place-items": "center",
  "font-size": "26px",
};

/** "Réponse : …" banner, in the correct colour. */
function AnswerBanner(p: { readonly text: string; readonly w: number; readonly h: number }): JSX.Element {
  return (
    <div class="q-reveal-answer" data-state="correct" style={{ ...panel, width: "100%", height: "100%", display: "flex", "align-items": "center", gap: "28px", padding: "0 36px", "background-color": "var(--q-color-correct)" }}>
      <span style={{ "flex-shrink": 0, "font-size": "28px", opacity: 0.85 }}>Réponse</span>
      <div style={{ flex: 1, height: "100%" }}>
        <FitText text={p.text} max={64} box={{ w: Math.max(80, p.w - 220), h: Math.max(40, p.h - 24) }} />
      </div>
    </div>
  );
}

/** Revealed answer for the typed / oral mechanics (text-answer, hints / reveal-image in text mode, board, pin). */
export function RevealAnswerZone(p: ZoneProps): JSX.Element {
  const text = (): string | null => {
    const m = asPin(p.view.mechanic);
    if (m !== null) {
      const pins = m.pins ?? [];
      return `${pins.filter((x) => x.hit).length} / ${pins.length} dans la zone`;
    }
    return correctText(p.view.mechanic);
  };
  return (
    <Show when={isRevealed(p.view) ? text() : null}>
      {(t) => <AnswerBanner text={t()} w={p.zone.rect.w} h={p.zone.rect.h} />}
    </Show>
  );
}

/** Estimate: the right value, then the closest answers (top 5, names from the board). */
export function NumberAnswerZone(p: ZoneProps): JSX.Element {
  return (
    <Show when={isRevealed(p.view) ? asNumberAnswer(p.view.mechanic) : null}>
      {(m) => {
        const top = () => (m().ranking ?? []).slice(0, 5);
        const rowH = () => Math.max(24, Math.min(60, (p.zone.rect.h - 8 * 4) / 5));
        const unit = () => (m().unit === null || m().unit === "" ? "" : ` ${m().unit}`);
        return (
          <div style={{ display: "flex", gap: "20px", width: "100%", height: "100%" }}>
            <div style={{ flex: "0 0 42%" }}>
              <AnswerBanner text={correctText(m()) ?? ""} w={p.zone.rect.w * 0.42} h={p.zone.rect.h} />
            </div>
            <div class="q-number-ranking" style={{ flex: 1, display: "flex", "flex-direction": "column", gap: "8px" }}>
              <For each={top()}>
                {(r, i) => (
                  <div data-state={r.win ? "correct" : "idle"} style={{ ...panel, height: `${rowH()}px`, display: "flex", "align-items": "center", gap: "16px", padding: "0 20px", "font-size": `${Math.round(rowH() * 0.5)}px`, "background-color": r.win ? "var(--q-color-correct)" : "var(--q-color-surface)" }}>
                    <span style={{ width: "36px", color: "var(--q-color-muted)" }}>{i() + 1}</span>
                    <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{nameOf(p.view, r.participantId)}</span>
                    <span style={{ "font-variant-numeric": "tabular-nums" }}>{formatNumber(r.value)}{unit()}</span>
                    <span style={{ width: "150px", "text-align": "right", "font-size": "0.7em", color: "var(--q-color-muted)" }}>écart {formatNumber(r.gap)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

/** Order: the shown list (A, B, C…), then the right order (1, 2, 3…). */
export function OrderZone(p: ZoneProps): JSX.Element {
  return (
    <Show when={asOrder(p.view.mechanic)}>
      {(m) => {
        const done = () => isRevealed(p.view) && m().correct !== null;
        const items = () => (done() ? (m().correct ?? []).flatMap((id) => m().options.filter((o) => o.id === id)) : m().options);
        const gap = 16;
        const w = () => (p.zone.rect.w - gap * (items().length - 1)) / Math.max(1, items().length);
        return (
          <div class="q-order" data-revealed={String(done())} style={{ display: "grid", "grid-template-columns": `repeat(${Math.max(1, items().length)}, 1fr)`, gap: `${gap}px`, width: "100%", height: "100%" }}>
            <For each={items()}>
              {(o, i) => (
                <div class="q-order-item" data-state={done() ? "correct" : "idle"} style={{ ...panel, display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px", padding: "14px 16px", "background-color": done() ? "var(--q-color-correct)" : "var(--q-color-surface)", transition: "background-color var(--q-motion)" }}>
                  <span style={badge}>{done() ? i() + 1 : optionLetter(i())}</span>
                  <div style={{ width: "100%", flex: 1, "min-height": 0 }}>
                    <FitText text={o.label} max={40} box={{ w: w() - 32, h: Math.max(30, p.zone.rect.h - 100) }} />
                  </div>
                </div>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}

/** Pairs: two columns, then each left item linked to its right item. */
export function PairsZone(p: ZoneProps): JSX.Element {
  return (
    <Show when={asPairs(p.view.mechanic)}>
      {(m) => {
        const done = () => isRevealed(p.view) && m().correct !== null;
        const rows = () =>
          m().left.map((l, i) => {
            const rightId = done() ? m().correct?.find((c) => c.left === l.id)?.right : m().right[i]?.id;
            return { left: l.label, right: m().right.find((r) => r.id === rightId)?.label ?? "", i };
          });
        const gap = 10;
        const rowH = () => (p.zone.rect.h - gap * (rows().length - 1)) / Math.max(1, rows().length);
        const fs = () => Math.round(Math.min(34, rowH() * 0.48));
        const cell = (): JSX.CSSProperties => ({ ...panel, display: "flex", "align-items": "center", gap: "14px", padding: "0 20px", "font-size": `${fs()}px`, overflow: "hidden", "white-space": "nowrap", "background-color": done() ? "var(--q-color-correct)" : "var(--q-color-surface)", transition: "background-color var(--q-motion)" });
        return (
          <div class="q-pairs" data-revealed={String(done())} style={{ display: "grid", "grid-template-columns": "1fr 90px 1fr", "grid-auto-rows": `${rowH()}px`, gap: `${gap}px`, width: "100%", height: "100%" }}>
            <For each={rows()}>
              {(r) => (
                <>
                  <div class="q-pair-left" style={cell()}><b style={{ color: "var(--q-color-accent)" }}>{optionLetter(r.i)}</b><span>{r.left}</span></div>
                  <div style={{ display: "grid", "place-items": "center", "font-size": `${fs()}px`, opacity: done() ? 1 : 0, transition: "opacity var(--q-motion)" }}>⟷</div>
                  <div class="q-pair-right" style={cell()}><b style={{ color: "var(--q-color-accent)" }}>{done() ? "✓" : r.i + 1}</b><span>{r.right}</span></div>
                </>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}

/** Board (categories × values): played cells dimmed, the cell in play highlighted. */
export function BoardGrid(p: { readonly m: BoardView; readonly w: number; readonly h: number }): JSX.Element {
  const rows = () => boardRows(p.m);
  const gap = 8;
  const rowH = () => (p.h - gap * rows().length) / Math.max(1, rows().length + 1);
  const fs = () => Math.round(Math.min(48, rowH() * 0.55));
  const colW = () => (p.w - gap * (p.m.categories.length - 1)) / Math.max(1, p.m.categories.length);
  return (
    <div class="q-board" style={{ display: "grid", "grid-template-columns": `repeat(${Math.max(1, p.m.categories.length)}, 1fr)`, "grid-auto-rows": `${rowH()}px`, gap: `${gap}px`, width: "100%", height: "100%" }}>
      <For each={p.m.categories}>
        {(c) => (
          <div class="q-board-cat" style={{ ...panel, "background-color": "var(--q-color-primary)", padding: "0 10px", "text-transform": "uppercase" }}>
            <FitText text={c.name} max={Math.round(fs() * 0.7)} box={{ w: colW() - 20, h: rowH() }} />
          </div>
        )}
      </For>
      <For each={rows()}>
        {(row) => (
          <For each={row}>
            {(cell) => {
              const current = () => cell !== null && p.m.cell?.questionIndex === cell.questionIndex;
              const played = () => cell !== null && cell.played && !current();
              return (
                <Show when={cell} fallback={<div />}>
                  {(c) => (
                    <div class="q-board-cell" data-state={current() ? "selected" : played() ? "disabled" : "idle"} style={{ ...panel, display: "grid", "place-items": "center", "font-size": `${fs()}px`, "font-variant-numeric": "tabular-nums", "background-color": current() ? "var(--q-color-accent)" : "var(--q-color-surface)", color: current() ? "#111" : "var(--q-color-accent)", opacity: played() ? 0.22 : 1, transition: "opacity var(--q-motion), background-color var(--q-motion)" }}>
                      {played() ? "" : formatNumber(c().value)}
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        )}
      </For>
    </div>
  );
}

/** Board in the answers band: the grid, the options of a `single` clue, then the expected answer. */
export function BoardZone(p: ZoneProps & { readonly options: () => JSX.Element }): JSX.Element {
  return (
    <Show when={asBoard(p.view.mechanic)}>
      {(m) => (
        <Show when={!(isRevealed(p.view) && m().correct !== null)} fallback={<AnswerBanner text={m().correct ?? ""} w={p.zone.rect.w} h={p.zone.rect.h} />}>
          <Show when={m().cell !== null && m().options !== null} fallback={<BoardGrid m={m()} w={p.zone.rect.w} h={p.zone.rect.h} />}>
            {p.options()}
          </Show>
        </Show>
      )}
    </Show>
  );
}

/** Image box that shrink-wraps the picture, so overlays (tiles, pins) line up with it. */
function ImageFrame(p: { readonly src: string; readonly w: number; readonly h: number; readonly children: JSX.Element }): JSX.Element {
  return (
    <div style={{ width: "100%", height: "100%", display: "grid", "place-items": "center" }}>
      <div style={{ position: "relative", display: "inline-block", "line-height": 0, "border-radius": "var(--q-radius)", overflow: "hidden" }}>
        <img src={p.src} alt="" style={{ display: "block", "max-width": `${p.w}px`, "max-height": `${p.h}px` }} />
        {p.children}
      </div>
    </div>
  );
}

const pointsBadge: JSX.CSSProperties = { position: "absolute", top: "12px", right: "12px", padding: "8px 18px", "border-radius": "99px", background: "var(--q-color-accent)", color: "#111", "font-size": "30px", "line-height": 1.1, "font-variant-numeric": "tabular-nums" };

/** Picture under a cols × rows grid of tiles; uncovered tiles turn transparent, all of them at reveal. */
export function MaskedImage(p: ZoneProps): JSX.Element {
  return <Show when={asRevealImage(p.view.mechanic)}>{(m) => <MaskedImageOf {...p} m={m()} />}</Show>;
}

function MaskedImageOf(p: ZoneProps & { readonly m: RevealImageView }): JSX.Element {
  const hash = () => p.m.image?.hash ?? p.view.question?.prompt.media?.hash ?? null;
  const shown = () => new Set(p.m.revealed);
  const tiles = () => Array.from({ length: p.m.cols * p.m.rows }, (_, i) => i);
  return (
    <Show when={hash()}>
      {(h) => (
        <ImageFrame src={p.mediaUrl(h())} w={p.zone.rect.w} h={p.zone.rect.h}>
          <div class="q-tiles" style={{ position: "absolute", inset: 0, display: "grid", "grid-template-columns": `repeat(${p.m.cols}, 1fr)`, "grid-template-rows": `repeat(${p.m.rows}, 1fr)` }}>
            <For each={tiles()}>
              {(i) => <div class="q-tile" data-revealed={String(shown().has(i))} style={{ "background-color": "var(--q-color-surface)", "background-image": "var(--q-mat-image)", "box-shadow": "inset 0 0 0 1px var(--q-color-surface-alt)", opacity: shown().has(i) ? 0 : 1, transition: "opacity var(--q-motion)" }} />}
            </For>
          </div>
          <Show when={!isRevealed(p.view)}><span class="q-points" style={pointsBadge}>{p.m.points} pts</span></Show>
        </ImageFrame>
      )}
    </Show>
  );
}

/** Pin: the picture; at reveal, the target zone and every (anonymous) pin. */
export function PinImage(p: ZoneProps): JSX.Element {
  return <Show when={asPin(p.view.mechanic)}>{(m) => <PinImageOf {...p} m={m()} />}</Show>;
}

function PinImageOf(p: ZoneProps & { readonly m: PinView }): JSX.Element {
  const hash = () => p.m.image?.hash ?? p.view.question?.prompt.media?.hash ?? null;
  const done = () => isRevealed(p.view);
  return (
    <Show when={hash()}>
      {(h) => (
        <ImageFrame src={p.mediaUrl(h())} w={p.zone.rect.w} h={p.zone.rect.h}>
          <Show when={done() ? p.m.correct : null}>
            {(r) => <div class="q-pin-target" style={{ position: "absolute", left: `${r().x * 100}%`, top: `${r().y * 100}%`, width: `${r().w * 100}%`, height: `${r().h * 100}%`, border: "4px solid var(--q-color-correct)", background: "rgba(34,197,94,.22)", "border-radius": "8px", "box-sizing": "border-box" }} />}
          </Show>
          <Show when={done()}>
            <For each={p.m.pins ?? []}>
              {(pin) => <span class="q-pin-dot" data-hit={String(pin.hit)} style={{ position: "absolute", left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, width: "16px", height: "16px", margin: "-8px 0 0 -8px", "border-radius": "50%", background: pin.hit ? "var(--q-color-correct)" : "var(--q-color-wrong)", border: "2px solid #fff", "box-sizing": "border-box" }} />}
            </For>
          </Show>
        </ImageFrame>
      )}
    </Show>
  );
}

/** Hints shown so far and what a right answer is worth now. */
export function HintsPanel(p: ZoneProps): JSX.Element {
  return (
    <Show when={asHints(p.view.mechanic)}>
      {(m) => {
        const list = () => m().hints.slice(0, m().hintCount);
        const fs = () => Math.round(Math.max(18, Math.min(34, ((p.zone.rect.h - 80) / Math.max(3, list().length)) * 0.55)));
        return (
          <div class="q-hints" style={{ ...panel, position: "relative", width: "100%", height: "100%", padding: "18px 28px", display: "flex", "flex-direction": "column", gap: "10px", overflow: "hidden" }}>
            <div style={{ display: "flex", "align-items": "center", "font-size": "26px", color: "var(--q-color-muted)", "min-height": "40px" }}>Indices</div>
            <Show when={!isRevealed(p.view)}><span class="q-points" style={pointsBadge}>{m().points} pts</span></Show>
            <For each={list()}>
              {(h, i) => (
                <div class="q-hint" style={{ display: "flex", "align-items": "center", gap: "14px", "font-size": `${fs()}px`, "line-height": 1.2 }}>
                  <span style={{ ...badge, width: `${fs() * 1.4}px`, height: `${fs() * 1.4}px`, "font-size": `${Math.round(fs() * 0.75)}px` }}>{i() + 1}</span>
                  <span>{h}</span>
                </div>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );
}

/** Mechanics drawn in the `question-media` zone instead of the plain question media. */
export const MEDIA_MECHANICS: ReadonlySet<string> = new Set(["pin", "reveal-image", "hints"]);

/** `question-media` for the phase 3 mechanics (switch keyed on the mechanic kind: no remount per view). */
export function MechanicMedia(p: ZoneProps): JSX.Element {
  const kind = () => p.view.mechanic?.mechanic ?? null;
  return (
    <Switch>
      <Match when={kind() === "pin"}><PinImage {...p} /></Match>
      <Match when={kind() === "reveal-image"}><MaskedImage {...p} /></Match>
      <Match when={kind() === "hints"}><HintsPanel {...p} /></Match>
    </Switch>
  );
}
