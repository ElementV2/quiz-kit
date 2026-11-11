import { For, Show, createEffect, createSignal, onCleanup, type Component, type JSX } from "solid-js";
import type { View, Zone, ZoneType } from "@quiz/schema";
import { estimateFontSize, optionLetter, optionShare, optionState, readPath, secondsLeft } from "./logic.ts";

export type ZoneProps = { readonly zone: Zone; readonly view: View; readonly serverNow: () => number; readonly mediaUrl: (hash: string) => string };

const num = (z: Zone, key: string, fallback: number): number => {
  const v = z.props[key];
  return typeof v === "number" ? v : fallback;
};
const str = (z: Zone, key: string, fallback: string): string => {
  const v = z.props[key];
  return typeof v === "string" ? v : fallback;
};

const panel: JSX.CSSProperties = {
  background: "var(--q-color-surface)",
  "border-radius": "var(--q-radius)",
  "box-shadow": "0 10px 30px rgba(0,0,0,.35)",
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
    <Show when={m()?.mechanic === "choice" ? m() : null}>
      {(mech) => {
        const opts = () => (mech().mechanic === "choice" ? mech().options : []);
        const rows = () => Math.ceil(opts().length / columns());
        const cellH = () => (p.zone.rect.h - gap() * (rows() - 1)) / Math.max(1, rows());
        const cellW = () => (p.zone.rect.w - gap() * (columns() - 1)) / columns();
        return (
          <div style={{ display: "grid", "grid-template-columns": `repeat(${columns()}, 1fr)`, gap: `${gap()}px`, width: "100%", height: "100%" }}>
            <For each={opts()}>
              {(o, i) => {
                const state = () => optionState(mech(), o.id, myAnswer());
                const share = () => optionShare(mech(), o.id);
                const bg = () =>
                  state() === "correct" ? "var(--q-color-correct)" : state() === "selected" ? "var(--q-color-selected)" : "var(--q-color-surface)";
                return (
                  <div
                    class="q-answer"
                    data-state={state()}
                    style={{ ...panel, position: "relative", overflow: "hidden", display: "flex", "align-items": "center", gap: "20px", padding: "0 28px", background: bg(), opacity: state() === "wrong" ? 0.45 : 1, transition: "background var(--q-motion), opacity var(--q-motion)", ...p.zone.states[state()] }}
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
        <div style={{ ...panel, width: "100%", height: "100%", overflow: "hidden", display: "grid", "place-items": "center", background: "transparent", "box-shadow": "none" }}>
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

const ImageZone: Component<ZoneProps> = (p) => <img src={str(p.zone, "src", "")} alt="" style={{ width: "100%", height: "100%", "object-fit": "contain" }} />;

/** Zone registry (CONVENTIONS « O » : new zone type = new entry, no change to the scene renderer). */
const REGISTRY: Record<ZoneType, Component<ZoneProps>> = {
  question: QuestionZone,
  "question-media": QuestionMediaZone,
  "answer-list": AnswerListZone,
  timer: TimerZone,
  leaderboard: LeaderboardZone,
  "round-info": RoundInfoZone,
  "answer-count": AnswerCountZone,
  text: TextZone,
  image: ImageZone,
};

export const zoneComponent = (t: ZoneType): Component<ZoneProps> => REGISTRY[t];
