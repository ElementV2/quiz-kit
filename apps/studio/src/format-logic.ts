import { createRng, playedBy, type Registry } from "@quiz/engine";
import { PER_KIND_MECHANICS, type GameDocument, type Question, type Round, type ScoringComponent } from "@quiz/schema";
import { pruneRound } from "./flow-logic.ts";

/**
 * Format mode (doc 07): rounds as cards. Pure helpers, tested. The studio may run the engine (ADR-0007):
 * the compatibility check calls the real `init` of the round's mechanic on each question.
 */

export type Choice = { readonly value: string; readonly label: string };

export type ConfigField =
  | { readonly key: string; readonly kind: "number"; readonly label: string; readonly min?: number; readonly max?: number; readonly step?: number }
  | { readonly key: string; readonly kind: "boolean"; readonly label: string }
  | { readonly key: string; readonly kind: "enum"; readonly label: string; readonly options: readonly Choice[] }
  | { readonly key: string; readonly kind: "numbers"; readonly label: string; readonly hint?: string }
  /** Indices into another number-list field (ladder safe steps): one checkbox per item. */
  | { readonly key: string; readonly kind: "indexFlags"; readonly label: string; readonly of: string }
  | { readonly key: string; readonly kind: "flags"; readonly label: string; readonly options: readonly Choice[] }
  /** Optional text (empty = field removed). */
  | { readonly key: string; readonly kind: "text"; readonly label: string; readonly placeholder?: string };

export type MechanicInfo = {
  readonly label: string;
  readonly explain: string;
  /** Points come from the round's ScoringRule; otherwise the mechanic decides its own points. */
  readonly usesScoring: boolean;
  readonly fields: readonly ConfigField[];
  /** Explicit starting config (when `{}` is not valid on its own). */
  readonly seed?: Readonly<Record<string, unknown>>;
};

const allowChange: ConfigField = { key: "allowChange", kind: "boolean", label: "Le joueur peut changer sa réponse jusqu'à la fermeture" };
const progressive: ConfigField[] = [
  { key: "maxPoints", kind: "number", label: "Points si trouvé tout de suite", min: 0, max: 1_000_000 },
  { key: "minPoints", kind: "number", label: "Points si trouvé à la fin", min: 0, max: 1_000_000 },
  { key: "allowChange", kind: "boolean", label: "Le joueur peut répondre à nouveau (pour moins de points)" },
];

/** French catalogue of the registered mechanics (ids from packages/engine). */
export const MECHANICS: Readonly<Record<string, MechanicInfo>> = {
  mixed: {
    label: "Mixte (tous types)",
    explain: "Toutes les questions dans la même manche : chacune se joue selon son type — QCM et vrai / faux sur tablette, sondage en cases à découvrir, réponse orale au buzzer (l'animateur juge), réponse libre, nombre, ordre, associations, point sur image, répartition. Le barème vaut pour toutes, sauf le sondage (en équipes) qui compte ses propres points.",
    usesScoring: true,
    fields: [
      { key: "shuffleOptions", kind: "boolean", label: "QCM : mélanger l'ordre des réponses" },
      allowChange,
      { key: "pollMaxStrikes", kind: "number", label: "Sondage : erreurs avant de passer la main", min: 1, max: 10 },
      { key: "numberMode", kind: "enum", label: "Nombre : qui gagne", options: [{ value: "tolerance", label: "toute réponse dans la tolérance" }, { value: "closest", label: "le ou les plus proches" }] },
      { key: "buzzerLockout", kind: "boolean", label: "Réponse orale (buzzer) : qui se trompe ne peut plus buzzer" },
    ],
  },
  choice: {
    label: "QCM",
    explain: "Chacun répond sur sa tablette (QCM, vrai / faux, plusieurs réponses) ; le barème donne les points.",
    usesScoring: true,
    fields: [{ key: "shuffleOptions", kind: "boolean", label: "Mélanger l'ordre des réponses" }, allowChange],
  },
  "text-answer": {
    label: "Réponse libre",
    explain: "Chacun tape sa réponse ; accents, majuscules et petites fautes de frappe tolérés, la régie peut corriger.",
    usesScoring: true,
    fields: [allowChange],
  },
  "number-answer": {
    label: "Estimation (nombre)",
    explain: "Chacun donne un nombre : juste dans la tolérance de la question, ou seuls les plus proches gagnent.",
    usesScoring: true,
    fields: [
      { key: "mode", kind: "enum", label: "Qui gagne", options: [{ value: "tolerance", label: "toute réponse dans la tolérance" }, { value: "closest", label: "le ou les plus proches" }] },
      allowChange,
    ],
  },
  order: { label: "Remettre dans l'ordre", explain: "Les éléments sont mélangés : il faut les classer dans le bon ordre.", usesScoring: true, fields: [allowChange] },
  pairs: { label: "Associations", explain: "Relier chaque élément de gauche à celui de droite.", usesScoring: true, fields: [allowChange] },
  pin: { label: "Pin sur image", explain: "Chacun pose un point sur l'image ; juste s'il tombe dans la zone cible.", usesScoring: true, fields: [allowChange] },
  buzzer: {
    label: "Buzzer",
    explain: "Le premier qui buzze répond à l'oral, la régie valide ; une erreur passe la main au suivant.",
    usesScoring: true,
    fields: [{ key: "lockoutOnWrong", kind: "boolean", label: "Qui se trompe ne peut plus buzzer sur cette question" }],
  },
  "poll-board": {
    label: "Sondage à slots",
    explain: "Deux équipes retrouvent les réponses d'un sondage ; au bout de N erreurs la main passe. Points = % trouvés.",
    usesScoring: false,
    fields: [
      { key: "maxStrikes", kind: "number", label: "Erreurs avant de passer la main", min: 1, max: 10 },
      { key: "multiplier", kind: "number", label: "Multiplicateur (manche double, triple…)", min: 0.5, max: 100, step: 0.5 },
    ],
  },
  ladder: {
    label: "Paliers",
    explain: "Un candidat grimpe des paliers de gains ; les paliers assurés sont gardés en cas d'erreur, chaque joker sert une fois.",
    usesScoring: false,
    fields: [
      { key: "steps", kind: "numbers", label: "Gains de chaque palier (croissants)", hint: "ex. 100, 200, 500, 1000" },
      { key: "safeSteps", kind: "indexFlags", label: "Paliers assurés", of: "steps" },
      { key: "jokers", kind: "flags", label: "Jokers", options: [{ value: "fifty", label: "50 / 50" }, { value: "audience", label: "Vote du public" }] },
    ],
    seed: { steps: [100, 200, 500, 1000, 5000], safeSteps: [2], jokers: ["fifty", "audience"] },
  },
  allocation: {
    label: "Répartition de mise",
    explain: "Chacun répartit une mise entre les réponses ; on garde ce qui est posé sur la bonne.",
    usesScoring: false,
    fields: [allowChange, { key: "keepOneEmpty", kind: "boolean", label: "Obligation de laisser au moins une réponse vide" }],
  },
  board: {
    label: "Plateau catégories × valeurs",
    explain: "La régie choisit une case (catégorie = 1er tag de la question) ; buzzer, la bonne réponse rapporte la valeur.",
    usesScoring: false,
    fields: [
      { key: "values", kind: "numbers", label: "Valeurs des cases, de haut en bas", hint: "ex. 100, 200, 300, 400, 500" },
      { key: "penalty", kind: "boolean", label: "Une erreur coûte la valeur de la case" },
      { key: "lockoutOnWrong", kind: "boolean", label: "Qui se trompe ne peut plus buzzer sur cette case" },
    ],
  },
  hints: { label: "Indices dégressifs", explain: "Les indices de la question tombent un à un ; plus on répond tôt, plus on marque.", usesScoring: false, fields: progressive },
  "crowd-vote": {
    label: "Vote du chat (majorité)",
    explain: "Les spectateurs du chat Twitch / YouTube votent ; la majorité l'emporte (sondage ou QCM avec bonne réponse).",
    usesScoring: false,
    fields: [
      { key: "showLive", kind: "boolean", label: "Afficher la répartition des votes en direct" },
      { key: "streamDelayMs", kind: "number", label: "Retard du flux vidéo (ms) : votes encore acceptés après la fermeture", min: 0, max: 60_000, step: 100 },
      { key: "points", kind: "number", label: "Points pour l'équipe du chat si la majorité a raison", min: 0, max: 1_000_000 },
      { key: "teamId", kind: "text", label: "Équipe créditée (identifiant, ex. t_chat)", placeholder: "aucune" },
    ],
  },
  "reveal-image": {
    label: "Image dévoilée",
    explain: "L'image de la question se découvre case par case ; plus on répond tôt, plus on marque.",
    usesScoring: false,
    fields: [
      { key: "cols", kind: "number", label: "Colonnes de cases", min: 1, max: 12 },
      { key: "rows", kind: "number", label: "Lignes de cases", min: 1, max: 12 },
      ...progressive,
    ],
  },
};

export const mechanicLabel = (id: string): string => MECHANICS[id]?.label ?? id;

export { PER_KIND_MECHANICS } from "@quiz/schema";

/** Round types offered: « Mixte » then the real game formats; `current` stays listed (older games). */
export function mechanicOptions(registry: Registry, current?: string): { id: string; label: string; special: boolean }[] {
  const ids = registry.ids();
  const known = Object.keys(MECHANICS).filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id))]
    .filter((id) => !PER_KIND_MECHANICS.has(id) || id === current)
    .map((id) => ({ id, label: mechanicLabel(id), special: id !== "mixed" }));
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Starting config of a mechanic, fully explicit (defaults filled) so the form shows real values. */
export function defaultConfig(registry: Registry, mechanic: string): Record<string, unknown> {
  const seed = { ...MECHANICS[mechanic]?.seed };
  const r = registry.get(mechanic)?.configSchema.safeParse(seed);
  return r?.success === true && isRecord(r.data) ? { ...r.data } : seed;
}

/** Values shown by the form: the parsed config (defaults filled) when valid, else the raw object. */
export function configValues(registry: Registry, round: Pick<Round, "mechanic" | "mechanicConfig">): Record<string, unknown> {
  const raw = isRecord(round.mechanicConfig) ? round.mechanicConfig : {};
  const r = registry.get(round.mechanic)?.configSchema.safeParse(raw);
  return r?.success === true && isRecord(r.data) ? { ...raw, ...r.data } : { ...raw };
}

/** "100, 200 ; 300" → [100, 200, 300] (whole numbers lists); null when something is not a number. */
export function parseNumberList(text: string): number[] | null {
  const nums = text.split(/[,;\s]+/).filter((s) => s.length > 0).map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

export type RoundIssue = { readonly questionId: string | null; readonly message: string };

/**
 * Compatibility check of a round (Format card): structure, mechanic config, and each question (and reserve)
 * through the mechanic's own `init`, with a fake env (seed 1, phase idle) and no previous question.
 */
export function roundIssues(doc: GameDocument, ri: number, registry: Registry): RoundIssue[] {
  const round = doc.format.rounds[ri];
  if (round === undefined) return [];
  const issues: RoundIssue[] = [];
  if (round.questions.length === 0) issues.push({ questionId: null, message: "la manche n'a aucune question (il en faut au moins une pour enregistrer)" });
  const byId = new Map(doc.questions.map((q) => [q.id, q]));
  for (const id of [...round.questions, ...round.reserve]) if (!byId.has(id)) issues.push({ questionId: id, message: `question inconnue (${id})` });
  const m = registry.get(round.mechanic);
  if (m === null) return [...issues, { questionId: null, message: `mécanique inconnue : ${round.mechanic}` }];
  const cfg = m.configSchema.safeParse(round.mechanicConfig);
  if (!cfg.success) return [...issues, { questionId: null, message: `réglages invalides : ${cfg.error.issues.map((i) => i.message).join(" ; ")}` }];
  const questions = round.questions.flatMap((id) => byId.get(id) ?? []);
  const check = (q: Question, questionIndex: number, list: readonly Question[]) => {
    // The mechanic that will play this question (a mixed round picks one per answer kind).
    const played = playedBy(round, q, registry);
    if (!played.ok) {
      issues.push({ questionId: q.id, message: played.error.message });
      return;
    }
    if (played.value.mechanic.id === "poll-board" && doc.format.participants.mode !== "teams") {
      issues.push({ questionId: q.id, message: "un sondage façon « Une famille en or » se joue en équipes : passer la partie en « Équipes » (onglet Format), sinon il ne rapporte aucun point" });
    }
    const r = played.value.mechanic.init(played.value.config, q, { at: 0, rng: createRng(1, 1), phase: "idle" }, { previous: null, questionIndex, questionsLeft: list.length - questionIndex - 1, questions: list });
    if (!r.ok) issues.push({ questionId: q.id, message: r.error.message });
  };
  questions.forEach((q, i) => check(q, i, questions));
  // A reserve question replaces one of the round: checked as if it were played first.
  for (const id of round.reserve) {
    const q = byId.get(id);
    if (q !== undefined) check(q, 0, [q, ...questions]);
  }
  return issues;
}

// ───────────── Round edits (mutating, applied inside a store `produce`) ─────────────

export function newRound(registry: Registry, id: string, n: number): Round {
  return {
    id,
    title: `Manche ${n}`,
    mechanic: "mixed", // any question kind: the safest default (each one plays with its own rule)
    mechanicConfig: defaultConfig(registry, "mixed"),
    questions: [],
    reserve: [],
    timer: { durationMs: 20_000, autoLock: true },
    scoring: [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }],
  };
}

export function moveItem(list: unknown[], from: number, to: number): void {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
  const [x] = list.splice(from, 1);
  if (x !== undefined) list.splice(to, 0, x);
}

export function duplicateRound(d: GameDocument, ri: number, id: string): void {
  const r = d.format.rounds[ri];
  if (r === undefined) return;
  // JSON copy, not structuredClone: inside a Solid store `produce`, `r` is a proxy (DataCloneError).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON round-trip of a JSON round keeps its type
  const copy = JSON.parse(JSON.stringify(r)) as Round;
  d.format.rounds.splice(ri + 1, 0, { ...copy, id, title: `${r.title} (copie)` });
}

/** Deleting the last round is refused (a format has at least one). Its transitions and node position go with it. */
export function deleteRound(d: GameDocument, ri: number): boolean {
  const r = d.format.rounds[ri];
  if (d.format.rounds.length <= 1 || r === undefined) return false;
  d.format.rounds.splice(ri, 1);
  pruneRound(d.format, r.id); // its transitions would point to nothing (schema-invalid)
  return true;
}

export function setMechanic(d: GameDocument, ri: number, mechanic: string, registry: Registry): void {
  const r = d.format.rounds[ri];
  if (r === undefined || r.mechanic === mechanic) return;
  r.mechanic = mechanic;
  r.mechanicConfig = defaultConfig(registry, mechanic);
}

export function setConfigField(d: GameDocument, ri: number, key: string, value: unknown): void {
  const r = d.format.rounds[ri];
  if (r === undefined) return;
  const next: Record<string, unknown> = { ...(isRecord(r.mechanicConfig) ? r.mechanicConfig : {}), [key]: value };
  if (value === undefined) delete next[key]; // optional field cleared
  r.mechanicConfig = next;
}

export type RoundList = "questions" | "reserve";

export function addToRound(d: GameDocument, ri: number, qid: string, where: RoundList): void {
  const r = d.format.rounds[ri];
  if (r === undefined || r.questions.includes(qid) || r.reserve.includes(qid)) return;
  r[where].push(qid);
}

export function removeFromRound(d: GameDocument, ri: number, qid: string, where: RoundList): void {
  const r = d.format.rounds[ri];
  if (r !== undefined) r[where] = r[where].filter((x) => x !== qid);
}

/** Round question ↔ reserve. */
export function swapList(d: GameDocument, ri: number, qid: string, to: RoundList): void {
  const r = d.format.rounds[ri];
  if (r === undefined) return;
  removeFromRound(d, ri, qid, to === "questions" ? "reserve" : "questions");
  if (!r[to].includes(qid)) r[to].push(qid);
}

export type Refusal = { ok: true } | { ok: false; reason: string };

/**
 * Deletes a question from the bank and from every round / reserve. Refused (nothing changed) when it is the
 * last question of the game or the only question of a round.
 */
export function deleteQuestion(d: GameDocument, qid: string): Refusal {
  if (d.questions.length <= 1) return { ok: false, reason: "c'est la dernière question de la partie" };
  const emptied = d.format.rounds.filter((r) => r.questions.length === 1 && r.questions[0] === qid);
  if (emptied.length > 0) return { ok: false, reason: `c'est la seule question de ${emptied.map((r) => `« ${r.title} »`).join(", ")} : ajouter d'abord une autre question à cette manche` };
  d.questions = d.questions.filter((q) => q.id !== qid);
  for (const r of d.format.rounds) {
    r.questions = r.questions.filter((x) => x !== qid);
    r.reserve = r.reserve.filter((x) => x !== qid);
  }
  return { ok: true };
}

/** Rounds using a question, for the bank. */
export function roundsOf(d: GameDocument, qid: string): string[] {
  return d.format.rounds.flatMap((r, i) => {
    if (r.questions.includes(qid)) return [`${i + 1}. ${r.title}`];
    return r.reserve.includes(qid) ? [`${i + 1}. ${r.title} (réserve)`] : [];
  });
}

// ───────────── Scoring blocks ─────────────

export const SCORING_LABEL: Record<ScoringComponent["type"], string> = {
  base: "Points de base",
  timeDecay: "Dégressif selon la rapidité",
  penalty: "Pénalité si faux",
  multiplier: "Multiplicateur",
};

const SCORING_NEW: { readonly [K in ScoringComponent["type"]]: Extract<ScoringComponent, { type: K }> } = {
  base: { type: "base", points: 100 },
  timeDecay: { type: "timeDecay", minPoints: 50 },
  penalty: { type: "penalty", points: -50 },
  multiplier: { type: "multiplier", factor: 2 },
};

export const newScoring = (type: ScoringComponent["type"]): ScoringComponent => ({ ...SCORING_NEW[type] });
