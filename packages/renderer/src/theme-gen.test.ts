import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contrast, ensureContrast, generateThemes, parseHex, toHex } from "./theme-gen.ts";

describe("contrast (WCAG)", () => {
  it("matches known ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
  it("hex round-trips", () => {
    expect(toHex(parseHex("#7c5cff") ?? { r: 0, g: 0, b: 0 })).toBe("#7c5cff");
  });
});

describe("ensureContrast", () => {
  it("reaches the requested contrast, or the best possible one on that background", () => {
    const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);
    fc.assert(fc.property(hex, hex, fc.constantFrom(3, 4.5, 7), (fg, bg, min) => {
      const best = Math.max(contrast("#ffffff", bg), contrast("#000000", bg));
      expect(contrast(ensureContrast(fg, bg, min), bg)).toBeGreaterThanOrEqual(Math.min(min, best) - 1e-9);
    }), { numRuns: 500 });
  });
  it("AA body text (4.5) is always reachable", () => {
    const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);
    fc.assert(fc.property(hex, hex, (fg, bg) => {
      expect(contrast(ensureContrast(fg, bg, 4.5), bg)).toBeGreaterThanOrEqual(4.5);
    }), { numRuns: 500 });
  });
});

describe("generateThemes", () => {
  it("gives 4 valid variants with readable text for any brand colours", () => {
    const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);
    fc.assert(fc.property(hex, hex, (p, a) => {
      const themes = generateThemes(p, a);
      expect(themes).toHaveLength(4);
      for (const t of themes) {
        expect(contrast(t.theme.colors.text, t.theme.colors.surface)).toBeGreaterThanOrEqual(7);
        expect(contrast(t.theme.colors.muted, t.theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
      }
    }), { numRuns: 100 });
  });
  it("is deterministic", () => {
    expect(generateThemes("#e11d48", "#facc15")).toEqual(generateThemes("#e11d48", "#facc15"));
  });
});

const img = (pixels: [number, number, number, number, number][]) => {
  const out: number[] = [];
  for (const [r, g, b, a, count] of pixels) for (let i = 0; i < count; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
};

describe("dominantColors (logo → palette)", () => {
  it("returns the brand hues by frequency, ignoring white background, greys, transparency and same-hue shades", async () => {
    const { dominantColors } = await import("./theme-gen.ts");
    const data = img([
      [255, 255, 255, 255, 5000], // background
      [0, 0, 0, 0, 3000], // transparent
      [128, 128, 128, 255, 900], // grey text
      [230, 30, 60, 255, 800], // red
      [200, 20, 50, 255, 300], // darker red (same hue)
      [20, 90, 220, 255, 400], // blue
    ]);
    expect(dominantColors(data)).toEqual(["#e61e3c", "#145adc"]);
    expect(dominantColors(img([[255, 255, 255, 255, 10]]))).toEqual([]);
  });
});
