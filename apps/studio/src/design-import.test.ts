import { describe, expect, it } from "vitest";
import { PROGRAM_SCENE } from "@quiz/schema";
import { alignRects, assetSheetHtml, distributeRects, duplicateZone, freeId, pickColor, rectFromDrag, rgbToHex, zonesFromPsd } from "./design-import.ts";

const HD = { w: 1920, h: 1080 };

describe("PSD import by naming convention", () => {
  it("creates zones from `zone:<type>:<id>` layers and groups, reports fonts / colours, ignores the rest", () => {
    const r = zonesFromPsd(
      [
        { name: "Fond" },
        { name: "zone:question:question", left: 96, top: 540, right: 1824, bottom: 720 },
        { name: "zone:answer-list:answers", children: [{ name: "A", left: 96, top: 760, right: 950, bottom: 880 }, { name: "D", left: 970, top: 900, right: 1824, bottom: 1020 }] },
        { name: "zone:sparkles:fx", left: 0, top: 0, right: 10, bottom: 10 },
        { name: "zone:question:question", left: 0, top: 0, right: 100, bottom: 100 },
        { name: "Titre", text: { text: "Q", style: { font: { name: "Montserrat-Bold" }, fontSize: 64, fillColor: { r: 255, g: 204, b: 77 } } } },
      ],
      HD,
    );
    expect(r.zones.map((z) => [z.id, z.type, z.rect])).toEqual([
      ["question", "question", { x: 96, y: 540, w: 1728, h: 180 }],
      ["answers", "answer-list", { x: 96, y: 760, w: 1728, h: 260 }],
    ]);
    expect(r.ignored).toEqual(["zone:sparkles:fx : type inconnu", "zone:question:question : identifiant en double"]);
    expect(r.fonts).toEqual([{ name: "Montserrat-Bold", size: 64, layer: "Titre" }]);
    expect(r.colors).toEqual(["#ffcc4d"]);
  });

  it("rgbToHex accepts RGB only", () => {
    expect(rgbToHex({ r: 0, g: 128.4, b: 300 })).toBe("#0080ff");
    expect(rgbToHex({ c: 1, m: 0, y: 0, k: 0 })).toBeNull();
  });
});

describe("tracing, duplicating, aligning", () => {
  it("rectFromDrag normalizes any direction and ignores clicks", () => {
    expect(rectFromDrag({ x: 500, y: 300 }, { x: 100, y: 100 }, HD)).toEqual({ x: 100, y: 100, w: 400, h: 200 });
    expect(rectFromDrag({ x: 10, y: 10 }, { x: 12, y: 13 }, HD)).toBeNull();
    expect(rectFromDrag({ x: 1900, y: 1000 }, { x: 2500, y: 1400 }, HD)).toEqual({ x: 1900, y: 1000, w: 20, h: 80 });
  });

  it("duplicate gets a free id and goes below, or to the right when there is no room", () => {
    const z = { id: "card", type: "text" as const, rect: { x: 100, y: 100, w: 300, h: 100 }, props: {}, style: { color: "red" }, states: {} };
    const d = duplicateZone(z, new Set(["card", "card-2"]), HD);
    expect(d.id).toBe("card-3");
    expect(d.rect).toEqual({ x: 100, y: 216, w: 300, h: 100 });
    expect(d.style).toEqual({ color: "red" });
    expect(duplicateZone({ ...z, rect: { x: 100, y: 950, w: 300, h: 100 } }, new Set(), HD).rect).toEqual({ x: 416, y: 950, w: 300, h: 100 });
    expect(freeId("card-7", new Set())).toBe("card-2");
  });

  it("align on the first zone, or on the canvas for a single zone; distribute evenly", () => {
    const a = { x: 100, y: 100, w: 200, h: 50 };
    const b = { x: 400, y: 300, w: 100, h: 50 };
    expect(alignRects([a, b], "left", HD)[1]).toEqual({ ...b, x: 100 });
    expect(alignRects([a, b], "center-h", HD)[1]).toEqual({ ...b, x: 150 });
    expect(alignRects([b], "center-h", HD)[0]).toEqual({ ...b, x: 910 });
    expect(alignRects([b], "bottom", HD)[0]).toEqual({ ...b, y: 1030 });
    const d = distributeRects([{ x: 0, y: 0, w: 100, h: 10 }, { x: 700, y: 0, w: 100, h: 10 }, { x: 150, y: 0, w: 100, h: 10 }], "x");
    expect(d.map((r) => r.x)).toEqual([0, 700, 350]);
  });
});

describe("eyedropper and printable sheet", () => {
  it("pickColor reads RGBA bytes", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 18, 52, 86, 255]);
    expect(pickColor(data, 2, 1, 0)).toBe("#123456");
    expect(pickColor(data, 2, 5, 5)).toBeNull();
  });

  it("asset sheet page escapes names and has no script (CSP)", () => {
    const html = assetSheetHtml(PROGRAM_SCENE, [{ file: "a<b>_idle@2x.png", zone: "a<b>", state: "idle", x: 1, y: 2, w: 3, h: 4, w2: 6, h2: 8 }], () => "—", "<svg></svg>");
    expect(html).toContain("a&lt;b&gt;_idle@2x.png");
    expect(html).toContain("6×8");
    expect(html).not.toContain("<script");
  });
});

describe("PSD template round trip", () => {
  it("template layer names re-import as the same zones", async () => {
    const { psdTemplateLayers } = await import("./design-import.ts");
    const layers = psdTemplateLayers(PROGRAM_SCENE);
    const back = zonesFromPsd(layers.map((l) => ({ name: l.name, left: l.rect.x, top: l.rect.y, right: l.rect.x + l.rect.w, bottom: l.rect.y + l.rect.h })), HD);
    expect(back.ignored).toEqual([]);
    expect(back.zones.map((z) => [z.id, z.type, z.rect])).toEqual(PROGRAM_SCENE.layers.flatMap((l) => l.zones.map((z) => [z.id, z.type, z.rect])));
  });
});
