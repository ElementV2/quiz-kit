import { For, Show, createEffect, createSignal, onCleanup, type Component, type JSX } from "solid-js";
import type { View, Zone, ZoneType } from "@quiz/schema";
import { asBuzzer, asLadder, asPollBoard, estimateFontSize, nameOf, optionLetter, optionShare, optionState, optionsOf, readPath, secondsLeft } from "./logic.ts";

export type ZoneProps = { readonly zone: Zone; readonly view: View; readonly serverNow: () => number; readonly mediaUrl: (hash: string) => string };

const num = (z: Zone, key: string, fallback: number): number => {
  const v = z.props[key];
  return typeof v === "number" ? v : fallback;
};
const str = (z: Zone, key: string, fallback: string): string => {
  const v = z.props[key];
  return typeof v === "string" ? v : fallback;
};

/** Surfaces: state colour (background-color) under the theme material (doc 06 « matériau des cadres », `--q-mat-*`). */
const panel: JSX.CSSProperties = {
  "background-color": "var(--q-color-surface)",
  "background-image": "var(--q-mat-image)",
  "background-size": "var(--q-mat-size)",
  border: "var(--q-mat-border)",
  "backdrop-filter": "var(--q-mat-backdrop)",
  "border-radius": "var(--q-radius)",
  "box-shadow": "var(--q-mat-shadow)",
  "box-sizing": "border-box",
};

/** Auto-fit: shrink the font until the text fits the zone (doc 06 « auto-fit dans la textBox »). */
function FitText(p: { readonly text: string; readonly max: number; readonly box: { w: number; h: number }; readonly align?: string }): JSX.Element {
  let el: HTMLDivElement | undefined;
  const [size, setSize] = createSignal(estimateFontSize(p.text, p.box, p.max));
  createEffect(() => {
    let s = estimateFontSize(p.text, p.box, p.max);
    setSize(s);
    if (el === undefined) return;
    // Refine with the real DOM metrics (fonts differ from the estimate).
    queueMicrotask(() => {
      if (el === undefined) return;
      while (s > 18 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
        s -= 2;
        el.style.fontSize = `${s}px`;
      }
      setSize(s);
    });
  });
  return (
    <div ref={el} style={{ width: "100%", height: "100%", display: "flex", "align-items": "center", "justify-content": p.align ?? "center", "text-align": "center", "font-size": `${size()}px`, "line-height": 1.15, overflow: "hidden", "overflow-wrap": "anywhere" }}>
      {p.text}
    </div>
  );
}

const QuestionZone: Component<ZoneProps> = (p) => {
  const text = (): string => {
    const v = readPath(p.view, p.zone.bind ?? "question.prompt.text");
    return typeof v === "string" ? v : "";
  };
  return (
    <div style={{ ...panel, width: "100%", height: "100%", padding: "16px 40px" }}>
      <FitText text={text()} max={num(p.zone, "size", 64)} box={{ w: p.zone.rect.w - 80, h: p.zone.rect.h - 32 }} />
    </div>
  );
};

const AnswerListZone: Component<ZoneProps> = (p) => {
  const m = () => p.view.mechanic;
  const myAnswer = () => (p.view.role === "player" ? p.view.myAnswer : null);
  const columns = () => num(p.zone, "columns", 2);
  const gap = () => num(p.zone, "gap", 16);
  return (
    <Show when={optionsOf(m()).length > 0 ? m() : null}>
      {(mech) => {
        const opts = () => optionsOf(mech());
        const rows = () => Math.ceil(opts().length / columns());
        const cellH = () => (p.zone.rect.h - gap() * (rows() - 1)) / Math.max(1, rows());
        const cellW = () => (p.zone.rect.w - gap() * (columns() - 1)) / columns();
        return (
          <div style={{ display: "grid", "grid-template-columns": `repeat(${columns()}, 1fr)`, gap: `${gap()}px`, width: "100%", height: "100%" }}>
            <For each={opts()}>
              {(o, i) => {
                const state = () => optionState(mech(), o.id, myAnswer(), p.view.phase);
                const share = () => optionShare(mech(), o.id);
                const bg = () =>
                  state() === "correct" ? "var(--q-color-correct)" : state() === "selected" ? "var(--q-color-selected)" : "var(--q-color-surface)";
                return (
                  <div
                    class="q-answer"
                    data-state={state()}
                    style={{ ...panel, position: "relative", overflow: "hidden", display: "flex", "align-items": "center", gap: "20px", padding: "0 28px", "background-color": bg(), opacity: state() === "wrong" ? 0.45 : state() === "disabled" ? 0.12 : 1, transition: "background var(--q-motion), opacity var(--q-motion)", ...p.zone.states[state()] }}
                  >
                    <Show when={share() !== null}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round((share() ?? 0) * 100)}%`, background: "rgba(255,255,255,.12)", transition: "width var(--q-motion)" }} />
                    </Show>
                    <span style={{ position: "relative", "flex-shrink": 0, width: "56px", height: "56px", "border-radius": "50%", background: "var(--q-color-primary)", display: "grid", "place-items": "center", "font-size": "28px" }}>
                      {optionLetter(i())}
                    </span>
                    <div style={{ position: "relative", flex: 1, height: "100%" }}>
                      <FitText text={o.label} max={44} box={{ w: cellW() - 140, h: cellH() - 16 }} align="flex-start" />
                    </div>
                    <Show when={share() !== null}>
                      <span style={{ position: "relative", "font-size": "28px", color: "var(--q-color-muted)" }}>{Math.round((share() ?? 0) * 100)}%</span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        );
      }}
    </Show>
  );
};

const TimerZone: Component<ZoneProps> = (p) => {
  const [now, setNow] = createSignal(p.serverNow());
  const tick = setInterval(() => setNow(p.serverNow()), 100);
  onCleanup(() => clearInterval(tick));
  const left = () => (p.view.timer === null ? null : secondsLeft(p.view.timer.endsAt, now()));
  const ratio = () => (p.view.timer === null ? 0 : Math.max(0, Math.min(1, (p.view.timer.endsAt - now()) / p.view.timer.durationMs)));
  return (
    <Show when={left() !== null}>
      <div style={{ ...panel, width: "100%", height: "100%", display: "grid", "place-items": "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, bottom: 0, height: "8px", width: `${ratio() * 100}%`, background: (left() ?? 0) <= 5 ? "var(--q-color-wrong)" : "var(--q-color-accent)", transition: "width 100ms linear" }} />
        <span style={{ "font-size": `${Math.min(p.zone.rect.h * 0.6, 110)}px`, "font-variant-numeric": "tabular-nums", color: (left() ?? 0) <= 5 ? "var(--q-color-wrong)" : "var(--q-color-text)" }}>{left()}</span>
      </div>
    </Show>
  );
};

const LeaderboardZone: Component<ZoneProps> = (p) => {
  const rows = () => p.view.leaderboard.slice(0, num(p.zone, "maxRows", 10));
  const rowH = () => Math.min(80, (p.zone.rect.h - 80) / Math.max(1, num(p.zone, "maxRows", 10)));
  return (
    <div style={{ ...panel, width: "100%", height: "100%", padding: "24px 32px", display: "flex", "flex-direction": "column", gap: "8px" }}>
      <div style={{ "font-size": "36px", color: "var(--q-color-accent)", "margin-bottom": "8px" }}>{str(p.zone, "title", "Classement")}</div>
      <For each={rows()}>
        {(r) => (
          <div style={{ display: "flex", "align-items": "center", gap: "20px", height: `${rowH()}px`, padding: "0 20px", background: "var(--q-color-surface-alt)", "border-radius": "calc(var(--q-radius) / 2)", "font-size": `${Math.round(rowH() * 0.45)}px` }}>
            <span style={{ width: "48px", color: r.rank <= 3 ? "var(--q-color-accent)" : "var(--q-color-muted)" }}>{r.rank}</span>
            <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{r.displayName}</span>
            <span style={{ "font-variant-numeric": "tabular-nums" }}>{r.total}</span>
          </div>
        )}
      </For>
    </div>
  );
};

const RoundInfoZone: Component<ZoneProps> = (p) => (
  <div style={{ width: "100%", height: "100%", display: "flex", "align-items": "center", gap: "16px", "font-size": `${Math.round(p.zone.rect.h * 0.55)}px`, color: "var(--q-color-muted)" }}>
    <Show when={p.view.round}>{(r) => <span>{r().title}</span>}</Show>
    <Show when={p.view.question}>{(q) => <span style={{ color: "var(--q-color-accent)" }}>· Question {q().index + 1} / {q().count}</span>}</Show>
  </div>
);

const AnswerCountZone: Component<ZoneProps> = (p) => {
  const count = () => {
    const m = p.view.mechanic;
    return m !== null && "answeredCount" in m ? m.answeredCount : null;
  };
  return (
    <Show when={count() !== null}>
      <div style={{ ...panel, width: "100%", height: "100%", display: "flex", "align-items": "center", "justify-content": "center", gap: "16px", "font-size": "40px" }}>
        <span style={{ "font-size": "56px", color: "var(--q-color-accent)", "font-variant-numeric": "tabular-nums" }}>{count()}</span>
        <span style={{ color: "var(--q-color-muted)" }}>{str(p.zone, "label", "réponses")}</span>
      </div>
    </Show>
  );
};

const TextZone: Component<ZoneProps> = (p) => {
  const text = (): string => {
    if (p.zone.bind !== undefined) {
      const v = readPath(p.view, p.zone.bind);
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
    }
    return str(p.zone, "text", "");
  };
  return <FitText text={text()} max={num(p.zone, "size", 48)} box={{ w: p.zone.rect.w, h: p.zone.rect.h }} />;
};

/** Question picture / video / sound (blind test). Sound is embedded in the output so OBS / vMix capture it (doc 06). */
const QuestionMediaZone: Component<ZoneProps> = (p) => {
  const media = () => p.view.question?.prompt.media;
  return (
    <Show when={media()}>
      {(m) => (
        <div style={{ ...panel, width: "100%", height: "100%", overflow: "hidden", display: "grid", "place-items": "center", "background-color": "transparent", "background-image": "none", border: "none", "box-shadow": "none" }}>
          <Show when={m().mime.startsWith("image/")}>
            <img src={p.mediaUrl(m().hash)} alt="" style={{ "max-width": "100%", "max-height": "100%", "object-fit": "contain", "border-radius": "var(--q-radius)" }} />
          </Show>
          <Show when={m().mime.startsWith("video/")}>
            <video src={p.mediaUrl(m().hash)} autoplay muted={p.zone.props["sound"] !== true} loop playsinline style={{ "max-width": "100%", "max-height": "100%", "border-radius": "var(--q-radius)" }} />
          </Show>
          <Show when={m().mime.startsWith("audio/") && p.zone.props["sound"] !== false}>
            <audio src={p.mediaUrl(m().hash)} autoplay />
            <span style={{ "font-size": "96px" }}>♪</span>
          </Show>
        </div>
      )}
    </Show>
  );
};

/** `src`: URL, media hash, or `logo` (the theme logo, `--q-logo`). */
const ImageZone: Component<ZoneProps> = (p) => {
  const src = () => str(p.zone, "src", "");
  return (
    <Show when={src() !== "logo"} fallback={<div class="q-logo" style={{ width: "100%", height: "100%", "background-image": "var(--q-logo)", "background-size": "contain", "background-repeat": "no-repeat", "background-position": "center" }} />}>
      <img src={/^[0-9a-f]{64}$/.test(src()) ? p.mediaUrl(src()) : src()} alt="" style={{ width: "100%", height: "100%", "object-fit": "contain" }} />
    </Show>
  );
};

/** Survey board (« sondage à slots ») : masked slots revealed one by one, strikes, bank. */
const PollBoardZone: Component<ZoneProps> = (p) => (
  <Show when={asPollBoard(p.view.mechanic)}>
    {(m) => {
      const cols = () => (m().slots.length > 4 ? 2 : 1);
      return (
        <div style={{ width: "100%", height: "100%", display: "flex", "flex-direction": "column", gap: "12px" }}>
          <div style={{ flex: 1, display: "grid", "grid-template-columns": `repeat(${cols()}, 1fr)`, gap: "10px" }}>
            <For each={m().slots}>
              {(slot) => (
                <div class="q-slot" data-state={slot.revealed ? (slot.found ? "correct" : "revealed") : "masked"} style={{ ...panel, display: "flex", "align-items": "center", gap: "16px", padding: "0 22px", "background-color": slot.found ? "var(--q-color-correct)" : slot.revealed ? "var(--q-color-surface-alt)" : "var(--q-color-surface)", transition: "background var(--q-motion)", "font-size": "30px" }}>
                  <span style={{ width: "44px", height: "44px", "border-radius": "50%", background: "var(--q-color-primary)", display: "grid", "place-items": "center", "font-size": "24px" }}>{slot.index + 1}</span>
                  <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{slot.revealed ? (slot.label ?? "") : ""}</span>
                  <span style={{ "font-variant-numeric": "tabular-nums", color: "var(--q-color-accent)" }}>{slot.revealed ? (slot.value ?? "") : ""}</span>
                </div>
              )}
            </For>
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "18px", "font-size": "40px" }}>
            <For each={Array.from({ length: m().maxStrikes }, (_, i) => i)}>
              {(i) => <span style={{ color: i < m().strikes ? "var(--q-color-wrong)" : "rgba(255,255,255,.18)", "font-weight": 900 }}>✗</span>}
            </For>
            <span style={{ "margin-left": "auto", color: "var(--q-color-muted)" }}>Banque <b style={{ color: "var(--q-color-accent)" }}>{m().bank}</b></span>
          </div>
        </div>
      );
    }}
  </Show>
);

/** Buzzer: who has the hand, who won. Names come from the board carried by the view. */
const BuzzerZone: Component<ZoneProps> = (p) => (
  <Show when={asBuzzer(p.view.mechanic)}>
    {(m) => (
      <Show when={m().winner ?? m().hand}>
        {(id) => (
          <div style={{ ...panel, width: "100%", height: "100%", display: "flex", "align-items": "center", "justify-content": "center", gap: "18px", "font-size": `${Math.round(p.zone.rect.h * 0.42)}px`, "background-color": m().winner !== null ? "var(--q-color-correct)" : "var(--q-color-primary)" }}>
            <span>{m().winner !== null ? "✓" : "🔔"}</span>
            <span>{nameOf(p.view, id())}</span>
          </div>
        )}
      </Show>
    )}
  </Show>
);

/** Ladder (« paliers ») : steps bottom-up, current level, safe steps, jokers. */
const LadderZone: Component<ZoneProps> = (p) => (
  <Show when={asLadder(p.view.mechanic)}>
    {(m) => {
      const rows = () => m().steps.map((amount, i) => ({ amount, i })).toReversed();
      const rowH = () => Math.max(18, Math.min(48, (p.zone.rect.h - 70) / Math.max(1, m().steps.length)));
      return (
        <div style={{ ...panel, width: "100%", height: "100%", padding: "14px 18px", display: "flex", "flex-direction": "column", gap: "4px" }}>
          <div style={{ display: "flex", gap: "12px", "font-size": "22px", "margin-bottom": "6px" }}>
            <span style={{ opacity: m().jokers.fifty === "available" ? 1 : 0.3 }}>50:50</span>
            <span style={{ opacity: m().jokers.audience === "available" ? 1 : 0.3 }}>👥</span>
            <span style={{ "margin-left": "auto", color: "var(--q-color-muted)" }}>{m().status === "playing" ? "" : m().status === "won" ? "Gagné !" : m().status === "stopped" ? "Arrêt" : "Perdu"}</span>
          </div>
          <For each={rows()}>
            {(r) => {
              const current = () => r.i === m().level;
              const reached = () => r.i < m().level;
              return (
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", height: `${rowH()}px`, padding: "0 12px", "border-radius": "6px", "font-size": `${Math.round(rowH() * 0.6)}px`, background: current() ? "var(--q-color-accent)" : "transparent", color: current() ? "#111" : m().safeSteps.includes(r.i) ? "var(--q-color-text)" : reached() ? "var(--q-color-correct)" : "var(--q-color-muted)", "font-weight": m().safeSteps.includes(r.i) ? 900 : 600 }}>
                  <span>{r.i + 1}</span>
                  <span style={{ "font-variant-numeric": "tabular-nums" }}>{r.amount.toLocaleString("fr-FR")}</span>
                </div>
              );
            }}
          </For>
        </div>
      );
    }}
  </Show>
);

/** Zone registry (CONVENTIONS « O » : new zone type = new entry, no change to the scene renderer). */
const REGISTRY: Record<ZoneType, Component<ZoneProps>> = {
  question: QuestionZone,
  "question-media": QuestionMediaZone,
  "poll-board": PollBoardZone,
  buzzer: BuzzerZone,
  ladder: LadderZone,
  "answer-list": AnswerListZone,
  timer: TimerZone,
  leaderboard: LeaderboardZone,
  "round-info": RoundInfoZone,
  "answer-count": AnswerCountZone,
  text: TextZone,
  image: ImageZone,
};

export const zoneComponent = (t: ZoneType): Component<ZoneProps> => REGISTRY[t];
