import type { Zone } from "@quiz/schema";
import { GRID, snap } from "./studio-logic.ts";

/** Canvas editing helpers (Scenes tab), pure and tested. */

export type Rect = Zone["rect"];
export type Size = { readonly w: number; readonly h: number };
/** A zone of the current scene, by position. */
export type ZoneRef = { readonly layer: number; readonly zone: number };

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type Handle = (typeof HANDLES)[number];

const MIN = GRID * 2;

/** True when the zone sticks out of the stage (PSD import, JSON edit, older scene). */
export function overflows(r: Rect, size: Size): boolean {
  return r.x < 0 || r.y < 0 || r.x + r.w > size.w || r.y + r.h > size.h;
}

/** Brings a rectangle back inside the stage WITHOUT snapping (1 px nudges must stay 1 px). */
export function keepInside(r: Rect, size: Size): Rect {
  const w = Math.min(Math.max(1, r.w), size.w);
  const h = Math.min(Math.max(1, r.h), size.h);
  return { x: Math.min(Math.max(0, r.x), size.w - w), y: Math.min(Math.max(0, r.y), size.h - h), w, h };
}

/** Moves every rectangle by the same delta, the group staying inside the stage (shapes kept). */
export function moveRects(rects: readonly Rect[], dx: number, dy: number, size: Size): Rect[] {
  if (rects.length === 0) return [];
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  // Clamp the delta so the whole group stays in (a group already out is not pushed further out).
  const cdx = Math.max(Math.min(dx, Math.max(0, size.w - maxX)), Math.min(0, -minX));
  const cdy = Math.max(Math.min(dy, Math.max(0, size.h - maxY)), Math.min(0, -minY));
  return rects.map((r) => ({ ...r, x: r.x + cdx, y: r.y + cdy }));
}

/** Resize from one of the 8 handles by (dx, dy) stage pixels, snapped to the grid and kept in the stage. */
export function resizeFrom(start: Rect, handle: Handle, dx: number, dy: number, size: Size): Rect {
  let { x, y } = start;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes("w")) x = Math.min(snap(start.x + dx), right - MIN);
  if (handle.includes("e")) right = Math.max(snap(right + dx), x + MIN);
  if (handle.includes("n")) y = Math.min(snap(start.y + dy), bottom - MIN);
  if (handle.includes("s")) bottom = Math.max(snap(bottom + dy), y + MIN);
  x = Math.max(0, x);
  y = Math.max(0, y);
  right = Math.min(size.w, right);
  bottom = Math.min(size.h, bottom);
  return { x, y, w: Math.max(MIN, right - x), h: Math.max(MIN, bottom - y) };
}

/** Rubber band: rectangle between two points. */
export function bandRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Selection toggle (Shift + click): adds or removes, the first selected zone stays the reference. */
export function toggleRef(sel: readonly ZoneRef[], r: ZoneRef): ZoneRef[] {
  return sel.some((s) => s.layer === r.layer && s.zone === r.zone) ? sel.filter((s) => s.layer !== r.layer || s.zone !== r.zone) : [...sel, r];
}

/** Removes the selected zones from layers (indices handled from the end so they stay valid). */
export function removeZones(layers: readonly { zones: unknown[] }[], sel: readonly ZoneRef[]): number {
  const sorted = sel.toSorted((a, b) => b.layer - a.layer || b.zone - a.zone);
  let n = 0;
  for (const s of sorted) {
    const l = layers[s.layer];
    if (l !== undefined && s.zone < l.zones.length) {
      l.zones.splice(s.zone, 1);
      n++;
    }
  }
  return n;
}

/** Canvas scale: fit both the width and the height of the box, or a fixed zoom. */
export function fitScale(box: Size, stage: Size): number {
  if (box.w <= 0 || box.h <= 0) return 0.5;
  return Math.max(0.05, Math.min(box.w / stage.w, box.h / stage.h));
}

/** Short type code per zone type, for the zone list (text, never emoji). */
export const ZONE_CODE: Readonly<Record<string, string>> = {
  question: "QST",
  "question-media": "MED",
  "answer-list": "REP",
  "poll-board": "SDG",
  buzzer: "BZR",
  ladder: "PAL",
  timer: "CHR",
  leaderboard: "CLS",
  "round-info": "MAN",
  "answer-count": "CPT",
  "board-grid": "GRL",
  text: "TXT",
  image: "IMG",
};
