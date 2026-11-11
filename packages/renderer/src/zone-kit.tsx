import { createEffect, createSignal, type JSX } from "solid-js";
import type { View, Zone } from "@quiz/schema";
import { estimateFontSize } from "./logic.ts";

/** Shared building blocks of the zone components (surfaces, auto-fit text, zone props). */

export type ZoneProps = { readonly zone: Zone; readonly view: View; readonly serverNow: () => number; readonly mediaUrl: (hash: string) => string };

export const num = (z: Zone, key: string, fallback: number): number => {
  const v = z.props[key];
  return typeof v === "number" ? v : fallback;
};
export const str = (z: Zone, key: string, fallback: string): string => {
  const v = z.props[key];
  return typeof v === "string" ? v : fallback;
};

/** Surfaces: state colour (background-color) under the theme material (doc 06 « matériau des cadres », `--q-mat-*`). */
export const panel: JSX.CSSProperties = {
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
export function FitText(p: { readonly text: string; readonly max: number; readonly box: { w: number; h: number }; readonly align?: string }): JSX.Element {
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

