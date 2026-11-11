import { describe, expect, it } from "vitest";
import type { AnswerSpec } from "@quiz/schema";
import { splitCsvRow } from "@quiz/schema";
import { DEFAULT_BUZZER_KEYS, REGRADABLE_KINDS, assignBuzzerKey, buzzerKey, keyLabel, keyOfSeat, parseAcceptedLines, parseBuzzerKeys, ledgerRows, parsePlayersCsv, regradeSpec } from "./logic.ts";

describe("players CSV", () => {
  it("parses ; , and tab separated lines, header optional", () => {
    expect(parsePlayersCsv("Nom;Siège;Équipe\nAna;1;Rouges\nBo;2;\nCamille").rows).toEqual([
      { name: "Ana", seat: 1, team: "Rouges" },
      { name: "Bo", seat: 2, team: null },
      { name: "Camille", seat: null, team: null },
    ]);
    expect(parsePlayersCsv("Ana\t3\nBo\t4").rows.map((r) => r.seat)).toEqual([3, 4]);
    expect(parsePlayersCsv("Ana,5").rows[0]).toEqual({ name: "Ana", seat: 5, team: null });
  });

  it("keeps quoted separators and escaped quotes", () => {
    expect(splitCsvRow('"Dupont; Jean";2;"Les ""As"""', ";")).toEqual(["Dupont; Jean", "2", 'Les "As"']);
  });

  it("reports invalid and duplicate seats per line", () => {
    const r = parsePlayersCsv("Ana;1\nBo;1\nCé;x\n;2");
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual(["ligne 2 : siège 1 en double", "ligne 3 : siège invalide « x »", "ligne 4 : nom vide"]);
  });
});

describe("regrade editor", () => {
  const single: AnswerSpec = { kind: "single", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correct: "a" };
  const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  it("builds a corrected spec of the same kind, null when the draft is incomplete", () => {
    expect(regradeSpec(single, { picked: ["b"] })).toEqual({ ...single, correct: "b" });
    expect(regradeSpec(single, { picked: ["z"] })).toBeNull();
    expect(regradeSpec({ kind: "multi", options, correct: ["a"] }, { picked: ["a", "b"] })).toMatchObject({ correct: ["a", "b"] });
    expect(regradeSpec({ kind: "boolean", correct: true }, { truth: false })).toEqual({ kind: "boolean", correct: false });
    expect(regradeSpec({ kind: "text", accepted: ["Van Gogh"] }, { accepted: " Vincent van Gogh \n\nVan Gogh\nVan Gogh" })).toEqual({ kind: "text", accepted: ["Vincent van Gogh", "Van Gogh"] });
    expect(regradeSpec({ kind: "text", accepted: ["x"] }, { accepted: "  " })).toBeNull();
    expect(regradeSpec({ kind: "number", correct: 330, tolerance: 10, unit: "m" }, { correct: "324,5", tolerance: "" })).toEqual({ kind: "number", correct: 324.5, tolerance: 0, unit: "m" });
    expect(regradeSpec({ kind: "number", correct: 1, tolerance: 0 }, { correct: "abc" })).toBeNull();
    expect(regradeSpec({ kind: "oral", expected: "x" }, {})).toBeNull();
    expect(REGRADABLE_KINDS.has("pairs")).toBe(false);
  });

  it("drops blank and duplicate accepted lines", () => {
    expect(parseAcceptedLines("a\r\n\nb\na")).toEqual(["a", "b"]);
  });
});

describe("keyboard buzzers", () => {
  it("default 1–9, malformed storage falls back to it", () => {
    expect(parseBuzzerKeys(null)["3"]).toBe(3);
    expect(parseBuzzerKeys("{oops")).toBe(DEFAULT_BUZZER_KEYS);
    expect(parseBuzzerKeys('{"A": 2, "b": 0, "c": "x"}')).toEqual({ a: 2 });
  });
  it("one key per seat, one seat per key", () => {
    const m = assignBuzzerKey(DEFAULT_BUZZER_KEYS, 1, "Q");
    expect(m["q"]).toBe(1);
    expect(m["1"]).toBeUndefined();
    expect(keyOfSeat(assignBuzzerKey(m, 2, "q"), 1)).toBeNull();
    expect(buzzerKey("A")).toBe("a");
    expect(keyLabel(" ")).toBe("Espace");
  });
});

describe("regrade of order and allocation questions", () => {
  it("a new order (same items) and a new right option for an allocation", () => {
    const order: AnswerSpec = { kind: "order", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] };
    expect(regradeSpec(order, { order: ["c", "a", "b"] })).toEqual({ kind: "order", options: [{ id: "c", label: "C" }, { id: "a", label: "A" }, { id: "b", label: "B" }] });
    expect(regradeSpec(order, { order: ["a", "a", "b"] })).toBeNull();
    const alloc: AnswerSpec = { kind: "allocation", correct: "a", budget: 1000, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    expect(regradeSpec(alloc, { picked: ["b"] })).toEqual({ ...alloc, correct: "b" });
    expect(REGRADABLE_KINDS.has("order") && REGRADABLE_KINDS.has("allocation")).toBe(true);
  });
});

describe("ledgerRows (points history)", () => {
  it("newest first, in words: who, points, why, which question; cancelled lines kept", () => {
    const by = { role: "control", id: "op" } as const;
    const rows = ledgerRows({
      participants: [{ id: "p_1", displayName: "Ana", status: "active", teamId: null, seat: null, channel: "tablet", photo: null }],
      teams: [{ id: "t_r", name: "Rouges", color: "#f00", captainId: null }],
      rundown: [{ index: 0, title: "Manche 1", mechanic: "mixed", questions: [{ index: 1, id: "q_a", text: "?", status: "revealed" }] }],
      ledger: [
        { id: "s_1", target: { participantId: "p_1" }, teamId: null, delta: 100, questionId: "q_a", reason: "auto", note: null, by, at: 1, voided: false },
        { id: "s_2", target: { teamId: "t_r" }, teamId: "t_r", delta: -5, questionId: null, reason: "manual", note: null, by, at: 2, voided: true },
      ],
    } as never);
    expect(rows.map((r) => [r.who, r.delta, r.why, r.question, r.voided])).toEqual([["équipe Rouges", -5, "réglage manuel", null, true], ["Ana", 100, "réponse", "Manche 1 · Q2", false]]);
  });
});

