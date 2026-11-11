import { MIXED_CATEGORY, createRng, playedBy, type MixedCategory, type Registry } from "@quiz/engine";
import { ScoringComponent as ScoringComponentSchema, mechanicLabel as frenchMechanicLabel, type AnswerKind, type GameDocument, type Question, type Round, type ScoringComponent } from "@quiz/schema";
import { pruneRound } from "./flow-logic.ts";
import { newQuestion } from "./question-factories.ts";

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

const progressive: ConfigField[] = [
  { key: "maxPoints", kind: "number", label: "Points si trouvé tout de suite", min: 0, max: 1_000_000 },
  { key: "minPoints", kind: "number", label: "Points si trouvé à la fin", min: 0, max: 1_000_000 },
  { key: "allowChange", kind: "boolean", label: "Le joueur peut répondre à nouveau (pour moins de points)" },
];

/** French catalogue of the round types offered (ids from packages/engine): « Mixte » and the round-level formats. */
export const MECHANICS: Readonly<Record<string, MechanicInfo>> = {
  mixed: {
    label: "Mixte (tous types)",
    explain: "Toutes les questions dans la même manche : chacune se joue selon son type, avec les réglages et le barème de sa catégorie (ci-dessous).",
    usesScoring: true,
    fields: [], // by category: MIXED_CATEGORIES (own form)
    seed: { kinds: { poll: { mode: "per-answer" } } },
  },
  buzzer: {
    label: "Buzzer",
    explain: "Le premier qui buzze répond à l'oral, la régie valide ; une erreur passe la main au suivant.",
    usesScoring: true,
    fields: [{ key: "lockoutOnWrong", kind: "boolean", label: "Qui se trompe ne peut plus buzzer sur cette question" }],
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
  chain: {
    label: "La chaîne (banque et élimination)",
    explain: "Chacun son tour, à l'oral : une bonne réponse fait monter la chaîne, une erreur la remet à zéro ; on met en banque avant sa question. Vote d'élimination après chaque manche, duel final à deux : le gagnant remporte toutes les banques.",
    usesScoring: false,
    fields: [
      { key: "stage", kind: "enum", label: "Type de manche", options: [{ value: "chain", label: "Manche de chaîne" }, { value: "duel", label: "Duel final (deux derniers joueurs)" }] },
      { key: "steps", kind: "numbers", label: "Montants de la chaîne (croissants, manche de chaîne)", hint: "à renseigner, ex. 20, 50, 100, 200" },
      { key: "bankTarget", kind: "number", label: "Banque maximale de la manche (vide = le dernier montant)", min: 1, max: 100_000_000 },
      { key: "questionsEach", kind: "number", label: "Duel final : questions par joueur avant la mort subite", min: 1, max: 20 },
    ],
    // No amount imposed: the steps are left empty (a round without steps is refused when played, and listed in the issues).
    seed: { stage: "chain", steps: [] },
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

/** Offered types: the catalogue label; older ones (parties launched before « Mixte »): their French name. */
export const mechanicLabel = (id: string): string => MECHANICS[id]?.label ?? frenchMechanicLabel(id);

/** Round types offered: « Mixte » first, then the formats that set the rule of the whole round. */
export function mechanicOptions(registry: Registry): { id: string; label: string; special: boolean }[] {
  const ids = registry.ids();
  return Object.keys(MECHANICS)
    .filter((id) => ids.includes(id))
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
    const r = played.value.mechanic.init(played.value.config, q, { at: 0, rng: createRng(1, 1), phase: "idle" }, { previous: null, questionIndex, questionsLeft: list.length - questionIndex - 1, questions: list });
    if (!r.ok) issues.push({ questionId: q.id, message: r.error.message });
  };
  questions.forEach((q, i) => check(q, i, questions));
  // A question's own points that will not be used: say it (never silently ignored).
  for (const q of questions) {
    if (q.scoring === undefined) continue;
    const played = playedBy(round, q, registry);
    if (played.ok && played.value.mechanic.ownPoints === true) issues.push({ questionId: q.id, message: "ses points propres ne servent pas ici : ce type de question décide de ses points (régler la catégorie ou le format)" });
    else if (q.scoring.some((c) => c.type === "timeDecay") && round.timer === undefined) issues.push({ questionId: q.id, message: "points dégressifs sans chrono : la question rapporte toujours le maximum (activer le chrono de la manche)" });
  }
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

// ───────────── « Mixte » round: settings by question category ─────────────

export type MixedCategoryInfo = {
  readonly id: MixedCategory;
  readonly label: string;
  readonly kinds: readonly AnswerKind[];
  readonly explain: string;
  readonly fields: readonly ConfigField[];
  /** The category decides its own points (survey, allocation): no points rule of its own. */
  readonly ownPoints?: boolean;
};

const change: ConfigField = { key: "allowChange", kind: "boolean", label: "Le joueur peut changer sa réponse jusqu'à la fermeture" };

/** One block per category in Format (order = how often they are used). */
export const MIXED_CATEGORIES: readonly MixedCategoryInfo[] = [
  {
    id: "choice",
    label: "QCM et vrai / faux",
    kinds: ["single", "multi", "boolean"],
    explain: "Réponse sur la tablette ; points selon le barème.",
    fields: [
      { key: "shuffleOptions", kind: "boolean", label: "Mélanger l'ordre des réponses (même ordre pour tout le monde)" },
      change,
      { key: "partialMulti", kind: "boolean", label: "Plusieurs bonnes réponses : points partiels (bonnes cochées − mauvaises cochées), sinon tout ou rien" },
      { key: "race", kind: "number", label: "Course : seuls les N plus rapides à répondre juste marquent (0 = tous)", min: 0, max: 1000 },
    ],
  },
  {
    id: "vote",
    label: "Vote (sans bonne réponse)",
    kinds: ["vote"],
    explain: "Chacun vote sur sa tablette ; l'écran montre les % à la révélation, le choix le plus voté en avant.",
    fields: [
      { key: "mode", kind: "enum", label: "Points", options: [{ value: "none", label: "aucun (simple vote)" }, { value: "majority", label: "à ceux qui votent comme la majorité" }, { value: "minority", label: "à ceux qui votent comme la minorité" }] },
      { key: "shuffleOptions", kind: "boolean", label: "Mélanger l'ordre des choix" },
      change,
    ],
  },
  {
    id: "poll",
    label: "Sondage",
    kinds: ["poll"],
    explain: "Retrouver les réponses d'un sondage. La main se donne à une équipe (si la régie en a créé) ou à un joueur. Points = % des réponses trouvées.",
    ownPoints: true,
    fields: [
      { key: "mode", kind: "enum", label: "Qui marque", options: [{ value: "per-answer", label: "chacun marque les réponses qu'il trouve" }, { value: "bank", label: "la banque entière à qui gagne la question (règle télé)" }] },
      { key: "maxStrikes", kind: "number", label: "Erreurs permises (ensuite : vol par l'autre camp, ou fin de la question sans vol)", min: 1, max: 10 },
      { key: "multiplier", kind: "number", label: "Multiplicateur (manche double, triple…)", min: 0.5, max: 100, step: 0.5 },
      { key: "steal", kind: "boolean", label: "Vol possible après la dernière erreur (une seule réponse pour l'autre camp)" },
      { key: "revealAll", kind: "boolean", label: "À la révélation, montrer aussi les réponses non trouvées" },
      { key: "strikesReset", kind: "boolean", label: "Erreurs remises à zéro quand la main passe (sinon elles restent pour tout le monde)" },
    ],
  },
  { id: "oral", label: "Réponse orale (buzzer)", kinds: ["oral"], explain: "Le premier qui buzze répond à voix haute ; l'animateur ou la régie juge.", fields: [{ key: "lockoutOnWrong", kind: "boolean", label: "Qui se trompe ne peut plus buzzer sur la question" }] },
  {
    id: "text",
    label: "Réponse libre",
    kinds: ["text"],
    explain: "Réponse tapée ; accents et majuscules ignorés. Une question peut fixer ses propres fautes tolérées (onglet Contenu).",
    fields: [change, { key: "typos", kind: "enum", label: "Fautes de frappe tolérées par défaut", options: [{ value: "auto", label: "auto (0 jusqu'à 4 lettres, 1 jusqu'à 8, sinon 2)" }, { value: "0", label: "aucune (orthographe exacte)" }, { value: "1", label: "1 lettre" }, { value: "2", label: "2 lettres" }, { value: "3", label: "3 lettres" }] }],
  },
  {
    id: "number",
    label: "Nombre (estimation)",
    kinds: ["number"],
    explain: "Un nombre. La tolérance de chaque question se règle dans Contenu ; ici, ce qui vaut pour toute la catégorie.",
    fields: [
      { key: "mode", kind: "enum", label: "Qui gagne", options: [{ value: "tolerance", label: "toute réponse dans la tolérance" }, { value: "closest", label: "les plus proches" }] },
      { key: "tolerancePercent", kind: "number", label: "Tolérance en % de la bonne réponse (en plus de celle de la question ; 0 = non)", min: 0, max: 100 },
      { key: "winners", kind: "number", label: "Mode « les plus proches » : nombre de gagnants (égalités comprises)", min: 1, max: 100 },
      { key: "graded", kind: "boolean", label: "Mode tolérance : points selon la précision (100 % pile, 50 % à la limite)" },
      change,
    ],
  },
  { id: "order", label: "Remettre dans l'ordre", kinds: ["order"], explain: "Classer les éléments.", fields: [change, { key: "partial", kind: "boolean", label: "Points partiels : part des éléments à la bonne place (sinon tout ou rien)" }] },
  { id: "pairs", label: "Associations", kinds: ["pairs"], explain: "Relier chaque élément à son partenaire.", fields: [change, { key: "partial", kind: "boolean", label: "Points partiels : part des paires justes (sinon tout ou rien)" }] },
  { id: "pin", label: "Point sur image", kinds: ["pin"], explain: "Poser un point dans la zone cible de l'image (zone réglée par question dans Contenu).", fields: [change, { key: "margin", kind: "number", label: "Marge autour de la zone cible (% de l'image : un point juste à côté compte)", min: 0, max: 50 }] },
  { id: "allocation", label: "Répartition de mise", kinds: ["allocation"], explain: "Répartir une mise entre les réponses ; on garde ce qui est posé sur la bonne.", ownPoints: true, fields: [change, { key: "keepOneEmpty", kind: "boolean", label: "Obligation de laisser au moins une réponse vide" }] },
];


const kindsOf = (cfg: Record<string, unknown>): Record<string, Record<string, unknown>> => {
  const k = cfg["kinds"];
  if (!isRecord(k)) return {};
  return Object.fromEntries(Object.entries(k).flatMap(([c, v]) => (isRecord(v) ? [[c, v]] : [])));
};

/** A category's field key → the key of the routed mechanic's settings (when they differ). */
const ROUTED_KEY: Readonly<Partial<Record<MixedCategory, Readonly<Record<string, string>>>>> = { poll: { mode: "scoring" }, vote: { mode: "vote" } };

/**
 * Values shown for one category: exactly what the engine applies — the round's config routed for a question of that
 * category (own value, else the flat key of older games), with the played mechanic's defaults filled. Never a blank
 * box for a setting the game applies (« vol » shown off while the game allowed it).
 */
export function mixedCategoryValues(registry: Registry, round: Pick<Round, "mechanic" | "mechanicConfig">, cat: MixedCategory): Record<string, unknown> {
  const info = MIXED_CATEGORIES.find((c) => c.id === cat);
  const kind = info?.kinds[0];
  const mixed = registry.get("mixed");
  const cfg = mixed?.configSchema.safeParse(round.mechanicConfig);
  const out: Record<string, unknown> = {};
  if (info === undefined || kind === undefined || mixed?.route === undefined || cfg === undefined || !cfg.success) return out;
  const routed = mixed.route(cfg.data, newQuestion(kind, "q_probe"));
  const played = registry.get(routed.id)?.configSchema.safeParse(routed.config);
  const values: Record<string, unknown> = played?.success === true && isRecord(played.data) ? played.data : {};
  for (const f of info.fields) out[f.key] = values[ROUTED_KEY[cat]?.[f.key] ?? f.key];
  return out;
}

/** Sets one setting of a category (`undefined` removes it: back to the flat / default value). */
export function setMixedField(d: GameDocument, ri: number, cat: MixedCategory, key: string, value: unknown): void {
  const r = d.format.rounds[ri];
  if (r === undefined) return;
  const cfg: Record<string, unknown> = { ...(isRecord(r.mechanicConfig) ? r.mechanicConfig : {}) };
  const kinds = kindsOf(cfg);
  const block: Record<string, unknown> = { ...kinds[cat], [key]: value };
  if (value === undefined) delete block[key];
  cfg["kinds"] = { ...kinds, [cat]: block };
  r.mechanicConfig = cfg;
}

/** A category's own points rule (`null`: back to the round's barème). */
export function setMixedScoring(d: GameDocument, ri: number, cat: MixedCategory, rule: ScoringComponent[] | null): void {
  setMixedField(d, ri, cat, "scoring", rule === null ? undefined : rule);
}

/** A category's own points rule, if any (shape-checked: what the editor can show). */
export function mixedScoring(round: Pick<Round, "mechanicConfig">, cat: MixedCategory): ScoringComponent[] | null {
  const own = kindsOf(isRecord(round.mechanicConfig) ? round.mechanicConfig : {})[cat]?.["scoring"];
  if (!Array.isArray(own) || own.length === 0) return null;
  const parts = own.map((c) => ScoringComponentSchema.safeParse(c));
  return parts.every((x) => x.success) ? parts.flatMap((x) => (x.success ? [x.data] : [])) : null;
}

/**
 * Keeps a points rule valid while it is edited: the decay minimum never above the base (else the whole round
 * would refuse to play). Mutates and returns the rule.
 */
export function normalizeRule(rule: ScoringComponent[]): ScoringComponent[] {
  const base = rule.reduce((sum, c) => (c.type === "base" ? sum + c.points : sum), 0);
  for (const c of rule) if (c.type === "timeDecay" && c.minPoints > base) c.minPoints = Math.max(0, base);
  return rule;
}

/** How many questions of the round (played + reserve) fall in each category. */
export function mixedCategoryCounts(doc: GameDocument, round: Round): Map<MixedCategory, number> {
  const out = new Map<MixedCategory, number>();
  const byId = new Map(doc.questions.map((q) => [q.id, q]));
  for (const id of [...round.questions, ...round.reserve]) {
    const q = byId.get(id);
    const cat = q === undefined ? undefined : MIXED_CATEGORY[q.answerSpec.kind]; // the engine's own mapping
    if (cat !== undefined) out.set(cat, (out.get(cat) ?? 0) + 1);
  }
  return out;
}

// ───────────── Points of one question ─────────────

/** How a question scores: by the barème (round / category), fixed points, a decay, or a custom rule. */
export type QuestionPoints = { readonly mode: "round" } | { readonly mode: "fixed"; readonly points: number } | { readonly mode: "decay"; readonly max: number; readonly min: number } | { readonly mode: "custom" };

export function questionPoints(q: Pick<Question, "scoring">): QuestionPoints {
  const r = q.scoring;
  if (r === undefined) return { mode: "round" };
  const base = r.flatMap((c) => (c.type === "base" ? [c] : []));
  const decay = r.flatMap((c) => (c.type === "timeDecay" ? [c] : []));
  const only = base.length === 1 ? base[0] : undefined;
  if (only !== undefined && r.length === 1) return { mode: "fixed", points: only.points };
  if (only !== undefined && decay.length === 1 && r.length === 2) return { mode: "decay", max: only.points, min: decay[0]?.minPoints ?? 0 };
  return { mode: "custom" };
}

/** The rule stored for a choice (min kept ≤ max so the question always plays). */
export function pointsRule(p: QuestionPoints, current?: Question["scoring"]): Question["scoring"] {
  switch (p.mode) {
    case "round":
      return undefined;
    case "fixed":
      return [{ type: "base", points: Math.round(p.points) }];
    case "decay":
      return [{ type: "base", points: Math.round(p.max) }, { type: "timeDecay", minPoints: Math.min(Math.round(p.min), Math.round(p.max)) }];
    case "custom":
      return current;
    default: {
      const never: never = p;
      return never;
    }
  }
}

