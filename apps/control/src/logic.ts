import type { ControlView } from "@quiz/schema";

/** Shared with the external control API (Companion / OSC). */
export { nextStep } from "@quiz/protocol";

export type PlayerRow = { readonly name: string; readonly seat: number | null; readonly team: string | null };

/** Splits one CSV line (`;`, `,` or tab), honouring double quotes ("a;b" stays one cell, "" is a quote). */
export function splitCsvLine(line: string, sep: string): string[] {
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

/**
 * Players pasted from Excel / Sheets or a CSV file (doc 09): `nom ; siège ; équipe`, header optional.
 * Returns valid rows and human-readable errors per line.
 */
export function parsePlayersCsv(text: string): { rows: PlayerRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const first = lines[0] ?? "";
  const sep = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const rows: PlayerRow[] = [];
  const errors: string[] = [];
  const seats = new Set<number>();
  lines.forEach((line, i) => {
    const [name = "", seatRaw = "", team = ""] = splitCsvLine(line, sep);
    if (i === 0 && /^(nom|name|pseudo|joueur)$/i.test(name)) return; // header
    if (name.length === 0) {
      errors.push(`ligne ${i + 1} : nom vide`);
      return;
    }
    if (name.length > 40) {
      errors.push(`ligne ${i + 1} : nom trop long (40 max)`);
      return;
    }
    let seat: number | null = null;
    if (seatRaw.length > 0) {
      const n = Number(seatRaw);
      if (!Number.isInteger(n) || n < 1 || n > 999) {
      errors.push(`ligne ${i + 1} : siège invalide « ${seatRaw} »`);
      return;
    }
      if (seats.has(n)) {
      errors.push(`ligne ${i + 1} : siège ${n} en double`);
      return;
    }
      seats.add(n);
      seat = n;
    }
    rows.push({ name, seat, team: team.length > 0 ? team : null });
  });
  return { rows, errors };
}

/** Pre-show checklist items (doc 05 « Prêt pour l'antenne »). */
export type CheckItem = { readonly label: string; readonly ok: boolean; readonly detail: string };

export function checklist(v: ControlView, s: { journal?: { ok?: boolean; journalMode?: unknown; synchronous?: unknown }; presence?: { seats?: number[]; byRole?: Record<string, number> } } | null): CheckItem[] {
  const seated = v.participants.filter((p) => p.seat !== null);
  const connectedSeats = new Set(s?.presence?.seats ?? []);
  const missing = seated.filter((p) => p.seat !== null && !connectedSeats.has(p.seat));
  const outputs = s?.presence?.byRole?.["output"] ?? 0;
  const journalOk = s?.journal?.ok === true && s.journal.journalMode === "wal" && s.journal.synchronous === 2;
  return [
    { label: "Journal actif (WAL, synchronous=FULL), disque OK", ok: journalOk, detail: journalOk ? "écriture vérifiée" : "voir le serveur" },
    { label: "Sorties ouvertes", ok: outputs > 0, detail: `${outputs} sortie(s) connectée(s)` },
    { label: "Joueurs créés", ok: v.participants.length > 0, detail: `${v.participants.length} joueur(s)` },
    { label: "Tablettes connectées et assignées", ok: seated.length > 0 && missing.length === 0, detail: missing.length === 0 ? `${seated.length} siège(s) OK` : `manquant(s) : siège ${missing.map((p) => p.seat).join(", ")}` },
    { label: "Aucune action ignorée après un undo", ok: v.skipped.length === 0, detail: v.skipped.length === 0 ? "RAS" : `${v.skipped.length} action(s) sans effet` },
  ];
}

type Spec = ControlView["rundown"][number]["questions"][number]["answerSpec"];

/** Answer kinds the control room can correct with a simple editor (`question.regrade`, doc 09). */
export const REGRADABLE_KINDS: ReadonlySet<Spec["kind"]> = new Set(["single", "multi", "boolean", "text", "number"]);

/** Accepted answers typed one per line (first = canonical), blanks and duplicates dropped. */
export function parseAcceptedLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0))];
}

/**
 * Corrected answer spec from the editor's draft (same kind as the original, other fields kept).
 * Returns null when the draft cannot be sent (nothing picked, empty list, not a number).
 */
export function regradeSpec(spec: Spec, draft: { readonly picked?: readonly string[] | undefined; readonly truth?: boolean | undefined; readonly accepted?: string | undefined; readonly correct?: string | undefined; readonly tolerance?: string | undefined }): Spec | null {
  switch (spec.kind) {
    case "single": {
      const id = draft.picked?.[0];
      return id === undefined || !spec.options.some((o) => o.id === id) ? null : { ...spec, correct: id };
    }
    case "multi": {
      const ids = (draft.picked ?? []).filter((id) => spec.options.some((o) => o.id === id));
      return ids.length === 0 ? null : { ...spec, correct: ids };
    }
    case "boolean":
      return draft.truth === undefined ? null : { ...spec, correct: draft.truth };
    case "text": {
      const accepted = parseAcceptedLines(draft.accepted ?? "");
      return accepted.length === 0 ? null : { ...spec, accepted };
    }
    case "number": {
      const correct = Number((draft.correct ?? "").replace(",", "."));
      const tolerance = Number((draft.tolerance ?? "0").replace(",", ".") || "0");
      if ((draft.correct ?? "").trim() === "" || !Number.isFinite(correct) || !Number.isFinite(tolerance) || tolerance < 0) return null;
      return { ...spec, correct, tolerance };
    }
    case "poll":
    case "vote":
    case "oral":
    case "order":
    case "pairs":
    case "pin":
    case "allocation":
      return null;
    default:
      return null;
  }
}

/** Is a question on air (the reserve replaces it), or does the reserve go to the next question? */
export const questionOnAir = (v: ControlView): boolean => v.question !== null && (v.phase === "presenting" || v.phase === "open" || v.phase === "locked" || v.phase === "judging");

export type RegradeDraft = { picked: string[]; truth: boolean | undefined; accepted: string; correct: string; tolerance: string };

/** Editor draft initialised from the current answer spec. */
export function initialRegradeDraft(spec: Spec): RegradeDraft {
  const d: RegradeDraft = { picked: [], truth: undefined, accepted: "", correct: "", tolerance: "0" };
  if (spec.kind === "single") d.picked = [spec.correct];
  else if (spec.kind === "multi") d.picked = [...spec.correct];
  else if (spec.kind === "boolean") d.truth = spec.correct;
  else if (spec.kind === "text") d.accepted = spec.accepted.join("\n");
  else if (spec.kind === "number") {
    d.correct = String(spec.correct);
    d.tolerance = String(spec.tolerance);
  }
  return d;
}

/** Keyboard buzzers (USB HID boxes seen as a keyboard): key → seat. Keys are `KeyboardEvent.key`, lowercased. */
export type BuzzerKeyMap = Readonly<Record<string, number>>;

/** Default mapping: 1–9 → seats 1–9 (top row and numeric keypad give the same `key`). */
export const DEFAULT_BUZZER_KEYS: BuzzerKeyMap = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), i + 1]));

/** Normalises a `KeyboardEvent.key` (letters are case-insensitive: Shift must not change the seat). */
export const buzzerKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/** Saved mapping (localStorage JSON) → valid map; anything malformed falls back to the default. */
export function parseBuzzerKeys(raw: string | null): BuzzerKeyMap {
  if (raw === null) return DEFAULT_BUZZER_KEYS;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return DEFAULT_BUZZER_KEYS;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) if (k.length > 0 && k.length <= 20 && typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999) out[buzzerKey(k)] = v;
    return out;
  } catch {
    return DEFAULT_BUZZER_KEYS;
  }
}

/** Assigns a key to a seat: the key leaves its previous seat, the seat keeps one key only. */
export function assignBuzzerKey(map: BuzzerKeyMap, seat: number, key: string): Record<string, number> {
  const k = buzzerKey(key);
  const out: Record<string, number> = {};
  for (const [kk, s] of Object.entries(map)) if (kk !== k && s !== seat) out[kk] = s;
  out[k] = seat;
  return out;
}

export const keyOfSeat = (map: BuzzerKeyMap, seat: number): string | null => Object.entries(map).find(([, s]) => s === seat)?.[0] ?? null;

/** Readable key name (`" "` → `Espace`). */
export const keyLabel = (key: string): string => (key === " " ? "Espace" : key.length === 1 ? key.toUpperCase() : key);
