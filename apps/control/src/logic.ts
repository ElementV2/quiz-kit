import type { Action, ControlView } from "@quiz/schema";

/** The single "next step" key (doc 08: space): the natural next control action for the current phase. */
export function nextStep(v: ControlView): { label: string; action: Action } | null {
  switch (v.phase) {
    case "lobby":
      return { label: "Démarrer la partie", action: { type: "game.start" } };
    case "idle":
      if (v.round === null) return { label: "Démarrer la manche", action: { type: "round.start" } };
      return { label: v.nextQuestion === null ? "Fin de manche" : "Présenter la question", action: { type: "question.present" } };
    case "round.end":
      return { label: "Manche suivante", action: { type: "round.start" } };
    case "presenting":
      return { label: "Ouvrir les réponses", action: { type: "question.open" } };
    case "open":
      return { label: "Fermer les réponses", action: { type: "question.lock" } };
    case "locked":
    case "judging":
      return { label: "Révéler", action: { type: "question.reveal" } };
    case "revealed":
      return { label: "Question suivante", action: { type: "question.next" } };
    case "game.end":
      return null;
    default:
      return null;
  }
}

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
