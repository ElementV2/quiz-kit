import { describe, expect, it } from "vitest";
import { DEMO_LADDER_GAME, DEMO_POLL_GAME, RETIRED_TEMPLATES, TEMPLATES } from "./fixtures.ts";
import { DEMO_ALLOCATION_GAME, DEMO_NUMBER_GAME } from "./fixtures-formats.ts";
import { PER_KIND_MECHANICS } from "./labels.ts";
import { toMixedRounds } from "./upgrade.ts";
import { loadGameDocument } from "./versioning.ts";

describe("one-kind rounds become « Mixte » on load (ADR-0015)", () => {
  it("keeps the settings that still mean something, is idempotent, leaves round-level formats alone", () => {
    const n = toMixedRounds(DEMO_NUMBER_GAME);
    expect(n.format.rounds[0]).toMatchObject({ mechanic: "mixed", mechanicConfig: { numberMode: "closest", pollScoring: "per-answer" } });
    expect(toMixedRounds(n)).toEqual(n);
    expect(toMixedRounds(DEMO_POLL_GAME).format.rounds[0]?.mechanicConfig).toEqual({ pollMaxStrikes: 3, pollScoring: "per-answer" });
    expect(toMixedRounds(DEMO_LADDER_GAME)).toBe(DEMO_LADDER_GAME);
    const double = structuredClone(DEMO_POLL_GAME);
    const r0 = double.format.rounds[0];
    if (r0 === undefined) throw new Error("fixture");
    r0.mechanicConfig = { maxStrikes: 2, multiplier: 2 };
    expect(toMixedRounds(double).format.rounds[0]?.mechanicConfig).toEqual({ pollMaxStrikes: 2, pollMultiplier: 2, pollScoring: "per-answer" });
    const alloc = structuredClone(DEMO_ALLOCATION_GAME);
    const a0 = alloc.format.rounds[0];
    if (a0 === undefined) throw new Error("fixture");
    a0.mechanicConfig = { keepOneEmpty: false };
    expect(toMixedRounds(alloc).format.rounds[0]?.mechanicConfig).toEqual({ allocationKeepOneEmpty: false, pollScoring: "per-answer" });
  });

  it("loadGameDocument upgrades by default, not when asked to keep the round types (live edit)", () => {
    const raw = structuredClone(DEMO_NUMBER_GAME);
    const up = loadGameDocument(raw);
    expect(up.ok && up.value.format.rounds[0]?.mechanic).toBe("mixed");
    const kept = loadGameDocument(raw, undefined, { upgradeRounds: false });
    expect(kept.ok && kept.value.format.rounds[0]?.mechanic).toBe("number-answer");
  });

  it("templates offer no one-kind round type; retired ids are not offered again", () => {
    expect(TEMPLATES.flatMap((t) => t.game.format.rounds.filter((r) => PER_KIND_MECHANICS.has(r.mechanic)).map((r) => `${t.id}:${r.mechanic}`))).toEqual([]);
    const offered = new Set(TEMPLATES.map((t) => t.id));
    expect(RETIRED_TEMPLATES.filter((t) => offered.has(t.id)).map((t) => t.id)).toEqual(["g_modele_sondage"]); // replaced in place
  });
});
