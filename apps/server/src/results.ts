import { leaderboard, PairsState, teamBoard, type Game, type Registry } from "@quiz/engine";

/**
 * After the show (doc 09): ranking, per-question detail (answers, verdict, points) and winners, computed from the
 * authoritative state (ledger + reveal history). Pure: same game → same export.
 */

export type ResultAnswer = { participantId: string; name: string; answer: string; outcome: "correct" | "wrong" | "none"; points: number };
export type ResultQuestion = { round: string; roundIndex: number; questionIndex: number; questionId: string; text: string; mechanic: string; answers: ResultAnswer[] };
export type Results = {
  title: string;
  ranking: { rank: number; participantId: string; name: string; team: string | null; total: number }[];
  teams: { rank: number; name: string; total: number }[];
  questions: ResultQuestion[];
};

/** Readable answer parts: pairs use anonymous ids (`a:r0`) on air, the export shows labels ("Japon → Tokyo"). */
function labelsOf(mechanicId: string, state: unknown): (part: string) => string {
  if (mechanicId !== "pairs") return (x) => x;
  const p = PairsState.safeParse(state);
  if (!p.success) return (x) => x;
  const left = new Map(p.data.left.map((l) => [l.id, l.label]));
  const right = new Map(p.data.right.map((r) => [r.id, r.label]));
  return (x) => {
    const [l = "", r = ""] = x.split(":");
    return `${left.get(l) ?? l} → ${right.get(r) ?? r}`;
  };
}

export function buildResults(game: Game, registry: Registry): Results {
  const s = game.state;
  const names = new Map(s.participants.map((p) => [p.id, p.displayName]));
  const teamName = new Map(s.teams.map((t) => [t.id, t.name]));
  const questions: ResultQuestion[] = s.history
    .toSorted((a, b) => a.roundIndex - b.roundIndex || a.questionIndex - b.questionIndex)
    .map((h) => {
      const m = registry.get(h.mechanicId);
      const q = s.game.questions.find((x) => x.id === h.questionId);
      const entryIds = new Set(h.entryIds);
      const points = new Map<string, number>();
      for (const e of s.ledger) {
        if (e.voided || !entryIds.has(e.id) || !("participantId" in e.target)) continue;
        points.set(e.target.participantId, (points.get(e.target.participantId) ?? 0) + e.delta);
      }
      const outcome = new Map<string, "correct" | "wrong">();
      const given = new Map<string, string>();
      if (m !== null) {
        for (const j of m.judge(h.state)) {
          const pid = j.kind === "rule" ? j.participantId : "participantId" in j.target ? j.target.participantId : null;
          if (pid !== null && outcome.get(pid) !== "correct") outcome.set(pid, j.outcome);
        }
        const label = labelsOf(h.mechanicId, h.state);
        for (const a of m.answers(h.state)) given.set(a.participantId, a.optionIds.map(label).join(" "));
      }
      const ids = [...new Set([...given.keys(), ...outcome.keys(), ...points.keys()])].filter((id) => names.has(id));
      return {
        round: s.game.format.rounds[h.roundIndex]?.title ?? `Manche ${h.roundIndex + 1}`,
        roundIndex: h.roundIndex,
        questionIndex: h.questionIndex,
        questionId: h.questionId,
        text: q?.prompt.text ?? h.questionId,
        mechanic: h.mechanicId,
        answers: ids.map((id) => ({ participantId: id, name: names.get(id) ?? id, answer: given.get(id) ?? "", outcome: outcome.get(id) ?? "none", points: points.get(id) ?? 0 })),
      };
    });
  return {
    title: s.game.title,
    ranking: leaderboard(s).map((r) => ({ rank: r.rank, participantId: r.participantId, name: r.displayName, team: r.teamId === null ? null : (teamName.get(r.teamId) ?? null), total: r.total })),
    teams: teamBoard(s).map((t) => ({ rank: t.rank, name: t.name, total: t.total })),
    questions,
  };
}

/** CSV cell for Excel (FR locale: `;` separator); a leading = + - @ is neutralised (formula injection). */
function cell(v: string | number): string {
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t) && typeof v === "string") t = `'${t}`;
  return /[";\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
}
const line = (cells: readonly (string | number)[]): string => cells.map(cell).join(";");

const OUTCOME_FR = { correct: "bonne", wrong: "fausse", none: "—" } as const;

/** UTF-8 BOM so that Excel opens accents correctly. */
export function resultsCsv(r: Results, kind: "ranking" | "detail"): string {
  const rows =
    kind === "ranking"
      ? [line(["Rang", "Joueur", "Équipe", "Total"]), ...r.ranking.map((x) => line([x.rank, x.name, x.team ?? "", x.total]))]
      : [
          line(["Manche", "N°", "Question", "Mécanique", "Joueur", "Réponse", "Verdict", "Points"]),
          ...r.questions.flatMap((q) => q.answers.map((a) => line([q.round, q.questionIndex + 1, q.text, q.mechanic, a.name, a.answer, OUTCOME_FR[a.outcome], a.points]))),
        ];
  return `﻿${rows.join("\r\n")}\r\n`;
}

const esc = (t: string | number): string => String(t).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Printable page (browser "Imprimer → PDF"): no script, inline styles only. */
export function resultsHtml(r: Results, at: string): string {
  const podium = r.ranking.filter((x) => x.rank <= 3);
  const teams = r.teams.length === 0 ? "" : `<h2>Équipes</h2><table><tr><th>Rang</th><th>Équipe</th><th>Total</th></tr>${r.teams.map((t) => `<tr><td>${t.rank}</td><td>${esc(t.name)}</td><td>${t.total}</td></tr>`).join("")}</table>`;
  const detail = r.questions
    .map((q) => `<h3>${esc(q.round)} · Q${q.questionIndex + 1} — ${esc(q.text)}</h3><table><tr><th>Joueur</th><th>Réponse</th><th>Verdict</th><th>Points</th></tr>${q.answers.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.answer)}</td><td>${OUTCOME_FR[a.outcome]}</td><td>${a.points}</td></tr>`).join("")}</table>`)
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Résultats — ${esc(r.title)}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#111}h1{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:8px 0 16px}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}th{background:#f2f2f2}.muted{color:#666}.podium{font-size:18px}
h3{margin:18px 0 4px;font-size:15px;break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}
</style></head><body><h1>${esc(r.title)}</h1><p class="muted">Résultats au ${esc(at)}</p>
<h2>Gagnants</h2><p class="podium">${podium.map((x) => `${x.rank}. ${esc(x.name)} (${x.total})`).join(" · ") || "—"}</p>
<h2>Classement</h2><table><tr><th>Rang</th><th>Joueur</th><th>Équipe</th><th>Total</th></tr>${r.ranking.map((x) => `<tr><td>${x.rank}</td><td>${esc(x.name)}</td><td>${esc(x.team ?? "")}</td><td>${x.total}</td></tr>`).join("")}</table>
${teams}<h2>Détail par question</h2>${detail || '<p class="muted">Aucune question révélée.</p>'}</body></html>`;
}
