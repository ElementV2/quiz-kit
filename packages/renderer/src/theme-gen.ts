import { Theme } from "@quiz/schema";

/**
 * Theme generation from two brand colours (doc 06 « Génération depuis 2 couleurs + logo : palette dérivée,
 * contrôle de contraste, 3 à 4 variantes »). Pure: same input → same themes. Contrast per WCAG 2.x
 * (relative luminance, ratio (L1 + 0.05) / (L2 + 0.05); AA body text ≥ 4.5).
 */

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? "000000", 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const byte = (x: number): string => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0");

export function toHex({ r, g, b }: Rgb): string {
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

const shade = (hex: string, h: (x: Hsl) => Hsl): string => {
  const rgb = parseHex(hex);
  return rgb === null ? hex : toHex(fromHsl(h(toHsl(rgb))));
};

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours (1 → 21). */
export function contrast(a: string, b: string): number {
  const A = parseHex(a);
  const B = parseHex(b);
  if (A === null || B === null) return 1;
  const [hi, lo] = [luminance(A), luminance(B)].toSorted((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * Moves the lightness of `fg` (keeping its hue) until it reaches `min` contrast on `bg`, towards whichever of
 * white / black contrasts more with `bg`. If no colour can reach `min` on that background, returns the best
 * possible one (pure white or black).
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const best = contrast("#ffffff", bg) >= contrast("#000000", bg) ? "#ffffff" : "#000000";
  const towards = best === "#ffffff" ? 1 : -1;
  let c = fg;
  for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = shade(c, (x) => ({ ...x, l: Math.max(0, Math.min(1, x.l + towards * 0.025)) }));
  return contrast(c, bg) >= min ? c : best;
}

export type GeneratedTheme = { readonly theme: Theme; readonly report: { readonly label: string; readonly ratio: number; readonly ok: boolean }[] };

const VARIANTS = [
  { id: "nuit", name: "Nuit", surfaceL: 0.14, altL: 0.2, sat: 0.45, motion: "snappy" },
  { id: "clair", name: "Clair", surfaceL: 0.96, altL: 0.9, sat: 0.35, motion: "elegant" },
  { id: "neon", name: "Néon", surfaceL: 0.08, altL: 0.13, sat: 0.7, motion: "bouncy" },
  { id: "papier", name: "Papier", surfaceL: 0.93, altL: 0.86, sat: 0.18, motion: "elegant" },
] as const;

/** 4 variants from a primary + accent colour. Text colours are corrected until AA contrast is met. */
export function generateThemes(primaryHex: string, accentHex: string, font = "Inter, 'Segoe UI', system-ui, sans-serif"): GeneratedTheme[] {
  const p = parseHex(primaryHex) ?? { r: 124, g: 92, b: 255 };
  const hue = toHsl(p).h;
  const accent = parseHex(accentHex) === null ? "#ffcc4d" : accentHex;
  return VARIANTS.map((v) => {
    const surface = toHex(fromHsl({ h: hue, s: v.sat, l: v.surfaceL }));
    const surfaceAlt = toHex(fromHsl({ h: hue, s: v.sat, l: v.altL }));
    const dark = v.surfaceL < 0.5;
    const text = ensureContrast(dark ? "#f4f5ff" : "#14162b", surface, 7);
    const muted = ensureContrast(toHex(fromHsl({ h: hue, s: 0.25, l: dark ? 0.72 : 0.38 })), surface, 4.5);
    const primary = toHex(p);
    const theme = Theme.parse({
      id: `gen-${v.id}`,
      name: v.name,
      colors: {
        surface,
        surfaceAlt,
        text,
        muted,
        primary,
        accent: ensureContrast(accent, surface, 3),
        correct: ensureContrast("#22c55e", surface, 3),
        wrong: ensureContrast("#ef4444", surface, 3),
        selected: ensureContrast("#38bdf8", surface, 3),
      },
      font: { family: font, weight: 700 },
      radius: v.id === "papier" ? 6 : 18,
      motion: v.motion,
    });
    const report = [
      { label: "Texte / fond", ratio: contrast(theme.colors.text, surface), min: 7 },
      { label: "Texte secondaire / fond", ratio: contrast(theme.colors.muted, surface), min: 4.5 },
      { label: "Accent / fond", ratio: contrast(theme.colors.accent, surface), min: 3 },
      { label: "Texte / bouton primaire", ratio: contrast("#ffffff", primary), min: 3 },
    ].map((r) => ({ label: r.label, ratio: Math.round(r.ratio * 10) / 10, ok: r.ratio >= r.min }));
    return { theme, report };
  });
}

/**
 * Dominant colours of a logo (doc 06 « génération depuis 2 couleurs + logo »): RGBA bytes → up to `n` distinct hues,
 * most frequent first. Transparent pixels and greys (low saturation, near black / white) are ignored: a logo on a
 * white background still yields its brand colours. Buckets of 4 bits per channel; average colour of each bucket.
 */
export function dominantColors(data: ArrayLike<number>, n = 2): string[] {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if ((data[i + 3] ?? 0) < 128) continue;
    const hsl = toHsl({ r, g, b });
    if (hsl.s < 0.25 || hsl.l < 0.08 || hsl.l > 0.94) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const k = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    k.count++;
    k.r += r;
    k.g += g;
    k.b += b;
    buckets.set(key, k);
  }
  const ranked = [...buckets.values()].toSorted((a, b) => b.count - a.count).map((k) => ({ r: k.r / k.count, g: k.g / k.count, b: k.b / k.count }));
  const out: Rgb[] = [];
  for (const c of ranked) {
    const h = toHsl(c).h;
    // Distinct hues only (≥ 30°), otherwise two shades of the same brand colour.
    if (out.every((o) => Math.min(Math.abs(toHsl(o).h - h), 360 - Math.abs(toHsl(o).h - h)) >= 30)) out.push(c);
    if (out.length === n) break;
  }
  return out.map((c) => toHex({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }));
}
