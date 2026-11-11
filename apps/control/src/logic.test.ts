import { describe, expect, it } from "vitest";
import { parsePlayersCsv, splitCsvLine } from "./logic.ts";

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
    expect(splitCsvLine('"Dupont; Jean";2;"Les ""As"""', ";")).toEqual(["Dupont; Jean", "2", 'Les "As"']);
  });

  it("reports invalid and duplicate seats per line", () => {
    const r = parsePlayersCsv("Ana;1\nBo;1\nCé;x\n;2");
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual(["ligne 2 : siège 1 en double", "ligne 3 : siège invalide « x »", "ligne 4 : nom vide"]);
  });
});
