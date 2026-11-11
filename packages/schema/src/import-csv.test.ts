import { describe, expect, it } from "vitest";
import { gameFromQuestions, parseQuestionsCsv } from "./import-csv.ts";

const CSV = `type;question;A;B;C;D;E;F;réponse;notes
qcm;Capitale de l'Italie ?;Milan;Rome;Turin;;;;B;Depuis 1871
multi;Nombres pairs ?;2;3;4;;;;A+C;
vf;Le soleil est une étoile.;;;;;;;vrai;`;

describe("parseQuestionsCsv", () => {
  it("parses qcm, multi and vf rows with a header", () => {
    const r = parseQuestionsCsv(CSV);
    expect(r.errors).toEqual([]);
    expect(r.questions.map((q) => q.answerSpec)).toEqual([
      { kind: "single", options: [{ id: "a", label: "Milan" }, { id: "b", label: "Rome" }, { id: "c", label: "Turin" }], correct: "b" },
      { kind: "multi", options: [{ id: "a", label: "2" }, { id: "b", label: "3" }, { id: "c", label: "4" }], correct: ["a", "c"] },
      { kind: "boolean", correct: true },
    ]);
    expect(r.questions[0]?.notes).toBe("Depuis 1871");
  });

  it("accepts tab-separated paste from a spreadsheet", () => {
    expect(parseQuestionsCsv("qcm\tQ ?\tx\ty\t\t\t\t\tA").questions).toHaveLength(1);
  });

  it("reports precise errors per line and keeps valid rows", () => {
    const r = parseQuestionsCsv("qcm;Q1;x;y;;;;;Z\ntruc;Q2\nqcm;;a;b;;;;;A\nqcm;Q4;seule;;;;;;A\nqcm;Q5;a;b;;;;;A+B\nvf;Q6;;;;;;;peut-être\nqcm;Q7;a;b;;;;;B");
    expect(r.questions.map((q) => q.prompt.text)).toEqual(["Q7"]);
    expect(r.errors).toEqual([
      "ligne 1 : bonne réponse « Z » absente des réponses proposées",
      "ligne 2 : type « truc » inconnu (qcm, multi, vf)",
      "ligne 3 : question vide",
      "ligne 4 : au moins 2 réponses (colonnes A à F)",
      "ligne 5 : une seule bonne réponse pour un qcm (utiliser « multi »)",
      "ligne 6 : réponse vrai/faux attendue",
    ]);
  });

  it("builds a valid playable game", () => {
    const g = gameFromQuestions("Soirée", parseQuestionsCsv(CSV).questions, { timerSeconds: 15, points: 100, maxPlayers: 200 });
    expect(g.format.rounds[0]?.questions).toHaveLength(3);
    expect(g.format.rounds[0]?.timer?.durationMs).toBe(15_000);
  });
});
