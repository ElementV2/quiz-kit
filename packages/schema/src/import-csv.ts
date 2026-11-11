import type { Question } from "./content.ts";
import { GameDocument } from "./session.ts";

/**
 * Questions pasted from Excel / Sheets or a CSV file (doc 07 « Contenu », roadmap phase 1).
 * Columns: type ; question ; A ; B ; C ; D ; E ; F ; bonne(s) réponse(s) ; notes
 * - type: `qcm` (one right answer), `multi` (several, letters separated by `+` or `,` inside the cell), `vf` (true/false).
 * - answer: a letter (A–F) for qcm / multi, `vrai` / `faux` for vf.
 * Separator auto-detected (tab, `;`, `,`), double quotes honoured, header line optional.
 */

export type CsvImportResult = { readonly questions: Question[]; readonly errors: string[] };

export function splitCsvRow(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const LETTERS = ["a", "b", "c", "d", "e", "f"] as const;
const TYPE_ALIASES: Record<string, "single" | "multi" | "boolean"> = {
  qcm: "single",
  single: "single",
  choix: "single",
  multi: "multi",
  multiple: "multi",
  vf: "boolean",
  "vrai/faux": "boolean",
  boolean: "boolean",
};

export function parseQuestionsCsv(text: string): CsvImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const first = lines[0] ?? "";
  const sep = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const questions: Question[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const cells = splitCsvRow(line, sep);
    const [typeRaw = "", prompt = ""] = cells;
    if (i === 0 && /^type$/i.test(typeRaw)) return; // header
    const n = i + 1;
    const kind = TYPE_ALIASES[typeRaw.toLowerCase()];
    if (kind === undefined) {
      errors.push(`ligne ${n} : type « ${typeRaw} » inconnu (qcm, multi, vf)`);
      return;
    }
    if (prompt.length === 0) {
      errors.push(`ligne ${n} : question vide`);
      return;
    }
    const answer = (cells[8] ?? "").toLowerCase();
    const notes = cells[9] ?? "";
    const id = `q_import_${String(questions.length + 1).padStart(3, "0")}`;
    const base = { id, prompt: { text: prompt }, hints: [], tags: [], ...(notes.length > 0 ? { notes } : {}) };
    if (kind === "boolean") {
      if (answer !== "vrai" && answer !== "faux" && answer !== "v" && answer !== "f") {
        errors.push(`ligne ${n} : réponse vrai/faux attendue`);
        return;
      }
      questions.push({ ...base, answerSpec: { kind: "boolean", correct: answer.startsWith("v") } });
      return;
    }
    const options = LETTERS.map((letter, k) => ({ id: letter, label: cells[2 + k] ?? "" })).filter((o) => o.label.length > 0);
    if (options.length < 2) {
      errors.push(`ligne ${n} : au moins 2 réponses (colonnes A à F)`);
      return;
    }
    const picked = answer.split(/[+,\s/]+/).filter((x) => x.length > 0);
    if (picked.length === 0 || !picked.every((p) => options.some((o) => o.id === p))) {
      errors.push(`ligne ${n} : bonne réponse « ${cells[8] ?? ""} » absente des réponses proposées`);
      return;
    }
    if (kind === "single") {
      if (picked.length !== 1) {
        errors.push(`ligne ${n} : une seule bonne réponse pour un qcm (utiliser « multi »)`);
        return;
      }
      questions.push({ ...base, answerSpec: { kind: "single", options, correct: picked[0] ?? "a" } });
    } else {
      questions.push({ ...base, answerSpec: { kind: "multi", options, correct: [...new Set(picked)] } });
    }
  });
  return { questions, errors };
}

/** A ready-to-play game from imported questions: one `choice` round with a timer and time-decayed points. */
export function gameFromQuestions(title: string, questions: readonly Question[], opts: { timerSeconds: number; points: number; maxPlayers: number }): GameDocument {
  return GameDocument.parse({
    schemaVersion: 1,
    title,
    questions,
    format: {
      id: "f_import",
      name: title,
      participants: { mode: "solo", min: 1, max: opts.maxPlayers },
      tieBreak: "control",
      rounds: [
        {
          id: "r_1",
          title: "Manche 1",
          mechanic: "choice",
          mechanicConfig: {},
          questions: questions.map((q) => q.id),
          reserve: [],
          timer: { durationMs: opts.timerSeconds * 1000, autoLock: true },
          scoring: [
            { type: "base", points: opts.points },
            { type: "timeDecay", minPoints: Math.round(opts.points / 2) },
          ],
        },
      ],
    },
  });
}
