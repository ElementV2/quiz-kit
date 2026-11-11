import { ZoneType, type Scene, type Zone } from "@quiz/schema";

/**
 * Design import (doc 07 A) and printable asset sheet (doc 07 B), pure and tested. The PSD is parsed by ag-psd in the
 * browser (lazy import); this module only works on the plain layer tree it returns.
 */

type Rect = Zone["rect"];
type Size = { readonly w: number; readonly h: number };

/** Subset of ag-psd's `Layer` we read (ag-psd 34 `psd.d.ts`: name, top/left/bottom/right, hidden, children, text.style). */
export type PsdNode = {
  readonly name?: string;
  readonly top?: number;
  readonly left?: number;
  readonly bottom?: number;
  readonly right?: number;
  readonly hidden?: boolean;
  readonly children?: readonly PsdNode[];
  readonly text?: { readonly text: string; readonly style?: { readonly font?: { readonly name: string }; readonly fontSize?: number; readonly fillColor?: unknown } };
};

/**
 * Naming convention for PSD layers / groups that become zones: `zone:<type>:<id>`, e.g. `zone:answer-list:answers`.
 * Any other layer is decoration (kept in the flattened reference image).
 */
export const PSD_ZONE_PATTERN = /^zone:([a-z-]+):([0-9a-z-]+)$/;

export type PsdImport = { zones: Zone[]; fonts: { name: string; size: number | null; layer: string }[]; colors: string[]; ignored: string[] };

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export function rgbToHex(c: unknown): string | null {
  if (typeof c !== "object" || c === null) return null;
  const o = Object.fromEntries(Object.entries(c));
  const r = o["r"];
  const g = o["g"];
  const b = o["b"];
  return typeof r === "number" && typeof g === "number" && typeof b === "number" ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : null;
}

export function zonesFromPsd(nodes: readonly PsdNode[], size: Size): PsdImport {
  const out: PsdImport = { zones: [], fonts: [], colors: [], ignored: [] };
  const seen = new Set<string>();
  const walk = (list: readonly PsdNode[]) => {
    for (const n of list) {
      const name = (n.name ?? "").trim();
      const m = PSD_ZONE_PATTERN.exec(name.toLowerCase());
      if (m !== null) {
        const type = ZoneType.safeParse(m[1]);
        const id = m[2] ?? "";
        const box = boundsOf(n);
        if (!type.success) out.ignored.push(`${name} : type inconnu`);
        else if (seen.has(id)) out.ignored.push(`${name} : identifiant en double`);
        else if (box === null) out.ignored.push(`${name} : calque vide`);
        else {
          seen.add(id);
          out.zones.push({ id, type: type.data, rect: fitRect(box, size), props: {}, style: {}, states: {} });
        }
      }
      if (n.text !== undefined) {
        const f = n.text.style?.font?.name;
        if (f !== undefined && !out.fonts.some((x) => x.name === f)) out.fonts.push({ name: f, size: n.text.style?.fontSize ?? null, layer: name });
        const c = rgbToHex(n.text.style?.fillColor);
        if (c !== null && !out.colors.includes(c)) out.colors.push(c);
      }
      if (n.children !== undefined) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Bounds of a layer, or of a group (union of its children). */
function boundsOf(n: PsdNode): Rect | null {
  if (n.left !== undefined && n.top !== undefined && n.right !== undefined && n.bottom !== undefined && n.right > n.left && n.bottom > n.top) {
    return { x: n.left, y: n.top, w: n.right - n.left, h: n.bottom - n.top };
  }
  const kids = (n.children ?? []).map(boundsOf).filter((r): r is Rect => r !== null);
  if (kids.length === 0) return null;
  const x = Math.min(...kids.map((r) => r.x));
  const y = Math.min(...kids.map((r) => r.y));
  return { x, y, w: Math.max(...kids.map((r) => r.x + r.w)) - x, h: Math.max(...kids.map((r) => r.y + r.h)) - y };
}

/** Exact pixels (no grid snap, unlike studio-logic `clampRect`): a PSD layer keeps its designer coordinates. */
export function fitRect(r: Rect, size: Size): Rect {
  const w = Math.max(8, Math.min(size.w, Math.round(r.w)));
  const h = Math.max(8, Math.min(size.h, Math.round(r.h)));
  return { x: Math.max(0, Math.min(size.w - w, Math.round(r.x))), y: Math.max(0, Math.min(size.h - h, Math.round(r.y))), w, h };
}

/** Tracing a zone on the reference: two pointer positions (any direction) → a normalized rect, null if too small (a click). */
export function rectFromDrag(a: { x: number; y: number }, b: { x: number; y: number }, size: Size, grid = 1): Rect | null {
  // Pointer outside the canvas: clip at the edge (never shift the zone).
  const sx = (v: number) => Math.max(0, Math.min(size.w, Math.round(v / grid) * grid));
  const sy = (v: number) => Math.max(0, Math.min(size.h, Math.round(v / grid) * grid));
  const x0 = sx(Math.min(a.x, b.x));
  const y0 = sy(Math.min(a.y, b.y));
  const x1 = sx(Math.max(a.x, b.x));
  const y1 = sy(Math.max(a.y, b.y));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return fitRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, size);
}

/** Next free id `<base>-2`, `<base>-3`… */
export function freeId(base: string, taken: ReadonlySet<string>): string {
  const root = base.replace(/-\d+$/, "");
  for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}

export function sceneIds(scene: Scene): Set<string> {
  return new Set(scene.layers.flatMap((l) => l.zones.map((z) => z.id)));
}

/** Duplicate a repeated zone: same look, placed right below (or to the right if no room), new id. */
export function duplicateZone(z: Zone, taken: ReadonlySet<string>, size: Size, gap = 16): Zone {
  const below = z.rect.y + z.rect.h + gap;
  const rect = below + z.rect.h <= size.h ? { ...z.rect, y: below } : { ...z.rect, x: Math.min(size.w - z.rect.w, z.rect.x + z.rect.w + gap) };
  return { ...structuredClone(z), id: freeId(z.id, taken), rect: fitRect(rect, size) };
}

export type Align = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";

/** Align zones on the first one (reference), like the align bar of design tools. One zone: align on the canvas. */
export function alignRects(rects: readonly Rect[], mode: Align, size: Size): Rect[] {
  const ref = rects.length > 1 ? rects[0] : { x: 0, y: 0, w: size.w, h: size.h };
  if (ref === undefined) return [];
  return rects.map((r, i) => {
    if (rects.length > 1 && i === 0) return r;
    switch (mode) {
      case "left": return { ...r, x: ref.x };
      case "right": return { ...r, x: ref.x + ref.w - r.w };
      case "center-h": return { ...r, x: Math.round(ref.x + (ref.w - r.w) / 2) };
      case "top": return { ...r, y: ref.y };
      case "bottom": return { ...r, y: ref.y + ref.h - r.h };
      case "center-v": return { ...r, y: Math.round(ref.y + (ref.h - r.h) / 2) };
    }
    return r; // unreachable (exhaustive switch), keeps consistent-return happy
  });
}

/** Even spacing between zones (sorted on the axis), first and last stay in place. */
export function distributeRects(rects: readonly Rect[], axis: "x" | "y"): Rect[] {
  if (rects.length < 3) return [...rects];
  const dim = axis === "x" ? "w" : "h";
  const order = rects.map((r, i) => ({ r, i })).toSorted((a, b) => a.r[axis] - b.r[axis]);
  const first = order[0]?.r;
  const last = order[order.length - 1]?.r;
  if (first === undefined || last === undefined) return [...rects];
  const total = order.reduce((s, o) => s + o.r[dim], 0);
  const gap = (last[axis] + last[dim] - first[axis] - total) / (order.length - 1);
  const out = [...rects];
  let cursor = first[axis];
  for (const o of order) {
    out[o.i] = { ...o.r, [axis]: Math.round(cursor) };
    cursor += o.r[dim] + gap;
  }
  return out;
}

/** Eyedropper on the reference image: RGBA bytes (ImageData.data) at a pixel → `#rrggbb`. */
export function pickColor(data: ArrayLike<number>, width: number, x: number, y: number): string | null {
  const i = (Math.floor(y) * width + Math.floor(x)) * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return r === undefined || g === undefined || b === undefined ? null : `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Printable asset sheet (doc 07 B « fiche assets PDF »): an HTML page laid out for A4, saved as PDF with the browser's
 * « Enregistrer en PDF » — no PDF library to ship, same content as the CSV. No script inside (CSP): the studio prints
 * it from a hidden iframe.
 */
export function assetSheetHtml(scene: Scene, rows: readonly { file: string; zone: string; state: string; x: number; y: number; w: number; h: number; w2: number; h2: number }[], nine: (zone: string) => string, templateSvg: string): string {
  const tr = rows.map((a) => `<tr><td><code>${esc(a.file)}</code></td><td>${esc(a.zone)}</td><td>${esc(a.state)}</td><td>${a.x}, ${a.y}</td><td>${a.w}×${a.h}</td><td><b>${a.w2}×${a.h2}</b></td><td>${esc(nine(a.zone))}</td></tr>`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche assets — ${esc(scene.name)}</title><style>
@page { size: A4 landscape; margin: 12mm; }
body { font: 11pt system-ui, sans-serif; color: #111; background: #fff; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 4mm; } p { margin: 0 0 3mm; color: #444; }
.tpl { width: 100%; border: 1px solid #ccc; margin-bottom: 6mm; } .tpl svg { width: 100%; height: auto; display: block; }
table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #bbb; padding: 1.5mm 2mm; text-align: left; font-size: 9.5pt; }
th { background: #eee; } tr { break-inside: avoid; } code { font-size: 9pt; }
</style></head><body>
<h1>Fiche assets — ${esc(scene.name)} (${scene.size.w}×${scene.size.h})</h1>
<p>Livrer chaque fichier en 2x (PNG alpha). Une zone répétée = un fichier par état, pas un par case. Nommage : <code>&lt;zone&gt;_&lt;état&gt;@2x.png</code>.</p>
<div class="tpl">${templateSvg}</div>
<table><thead><tr><th>Fichier</th><th>Zone</th><th>État</th><th>Position</th><th>Taille 1x</th><th>Taille 2x</th><th>9-slice</th></tr></thead><tbody>${tr}</tbody></table>
</body></html>`;
}

/** PSD template layers (doc 07 B « fichier calques »): one layer per zone, already named for re-import. */
export function psdTemplateLayers(scene: Scene): { name: string; group: string; rect: Rect }[] {
  return scene.layers.flatMap((l) => l.zones.map((z) => ({ name: `zone:${z.type}:${z.id}`, group: l.name, rect: z.rect })));
}
