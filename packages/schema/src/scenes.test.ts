import { describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "./scene-presets.ts";
import { Theme } from "./scenes.ts";

describe("Theme backward compatibility", () => {
  it("a theme saved before material / logo / sounds / volume still parses, with defaults", () => {
    const { material: _m, sounds: _s, volume: _v, ...old } = DEFAULT_THEME;
    const t = Theme.parse(old);
    expect(t).toMatchObject({ material: "flat", sounds: {}, volume: 0.8 });
    expect(t.logo).toBeUndefined();
    expect(Theme.safeParse({ ...old, sounds: { "no.such.cue": "a".repeat(64) } }).success).toBe(false);
  });
});
