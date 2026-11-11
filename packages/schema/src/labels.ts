import type { ActionType } from "./actions.ts";
import type { AnswerKind } from "./content.ts";
import type { Role } from "./roles.ts";
import type { ParticipantStatus } from "./session.ts";

/**
 * French labels for what operators read (rejection messages, screens). Code ids (`choice`, `order`, `host`…) never
 * reach the UI raw: use these. A mechanic registered later without a label falls back to its id.
 */

export const MECHANIC_LABEL_FR: Readonly<Record<string, string>> = {
  mixed: "mixte",
  choice: "QCM",
  "poll-board": "sondage à cases",
  buzzer: "buzzer",
  ladder: "paliers",
  "text-answer": "réponse libre",
  "number-answer": "estimation (nombre)",
  order: "remise en ordre",
  pairs: "associations",
  pin: "pin sur image",
  allocation: "répartition de mise",
  board: "plateau",
  hints: "indices",
  "reveal-image": "image révélée",
  "crowd-vote": "vote du chat",
  chain: "chaîne (banque et élimination)",
};

/**
 * Round types that play one kind of question only: a « Mixte » round plays them all (ADR-0015), so they are not
 * offered for new rounds (older games keep them).
 */
export const PER_KIND_MECHANICS: ReadonlySet<string> = new Set(["choice", "text-answer", "number-answer", "order", "pairs", "pin", "allocation", "poll-board"]);

export const ANSWER_KIND_LABEL_FR: Readonly<Record<AnswerKind, string>> = {
  single: "QCM (une réponse)",
  multi: "QCM (plusieurs réponses)",
  boolean: "vrai / faux",
  vote: "vote (sans bonne réponse)",
  poll: "sondage",
  oral: "réponse orale",
  text: "réponse libre",
  number: "nombre",
  order: "remettre dans l'ordre",
  pairs: "associations",
  pin: "pin sur image",
  allocation: "répartition",
};

export const ROLE_LABEL_FR: Readonly<Record<Role, string>> = {
  control: "la régie",
  "control-readonly": "la régie en lecture seule",
  host: "l'animateur",
  output: "une sortie",
  player: "un joueur",
  seat: "une tablette de siège",
  studio: "le studio",
  system: "le serveur",
};

export const STATUS_LABEL_FR: Readonly<Record<ParticipantStatus, string>> = {
  active: "en jeu",
  eliminated: "éliminé",
  substitute: "remplaçant",
};

/** What an action does, in words (« présenter la question »). */
export const ACTION_LABEL_FR: Readonly<Partial<Record<ActionType, string>>> = {
  "game.start": "démarrer la partie",
  "round.start": "démarrer une manche",
  "question.present": "présenter la question",
  "question.open": "ouvrir les réponses",
  "question.lock": "fermer les réponses",
  "question.reveal": "révéler",
  "question.next": "passer à la suite",
  "question.skip": "passer une question sans la jouer",
  "question.replaceFromReserve": "remplacer par une question de réserve",
  "question.edit": "modifier la question",
  "question.regrade": "corriger la réponse",
  "question.setStakes": "régler la mise",
  "answer.submit": "répondre",
  "answer.judge": "juger une réponse",
  buzz: "buzzer",
  "element.reveal": "dévoiler un élément",
  "joker.use": "utiliser un joker",
  "ladder.stop": "arrêter le candidat",
  "poll.control": "donner la main",
  "poll.steal": "donner le vol",
  "chain.bank": "mettre la chaîne en banque",
  "chain.end": "terminer la manche de chaîne",
  "chain.openVote": "ouvrir le vote d'élimination",
  "chain.vote": "voter",
  "chain.closeVote": "clore le vote d'élimination",
  "chain.pick": "départager le vote",
  "crowd.tally": "compter les votes du chat",
  "score.adjust": "corriger un score",
  "score.setTotal": "fixer un total",
  "score.void": "annuler une ligne de score",
  "answer.verdict": "corriger le verdict d'un joueur",
  "timer.set": "régler le chrono",
  "timer.stop": "arrêter le chrono",
  "timer.expired": "terminer le chrono",
  "player.add": "ajouter un joueur",
  "player.rename": "renommer un joueur",
  "player.setStatus": "changer le statut d'un joueur",
  "player.setTeam": "changer d'équipe",
  "player.setSeat": "changer de siège",
  "player.remove": "retirer un joueur",
  "layer.take": "mettre une couche à l'antenne",
  "layer.out": "retirer une couche de l'antenne",
  "team.add": "ajouter une équipe",
  "host.setDrive": "confier le pilotage à l'animateur",
  undo: "annuler",
};

export const mechanicLabel = (id: string): string => MECHANIC_LABEL_FR[id] ?? id;
export const answerKindLabel = (k: AnswerKind): string => ANSWER_KIND_LABEL_FR[k];
export const actionLabel = (t: ActionType): string => ACTION_LABEL_FR[t] ?? t;

/** « Une manche “remise en ordre” ne peut pas jouer une question “vrai / faux”. » */
export const unsupportedQuestion = (mechanicId: string, kind: AnswerKind): string =>
  `une manche « ${mechanicLabel(mechanicId)} » ne peut pas jouer une question « ${answerKindLabel(kind)} »`;

/** Where the points of a question come from (shown in the studio, the control room and to the host). */
export type PointsSource = "question" | "category" | "round" | "own";

export const POINTS_SOURCE_FR: Readonly<Record<PointsSource, string>> = {
  question: "points de cette question",
  category: "barème de sa catégorie",
  round: "barème de la manche",
  own: "points décidés par le jeu",
};

/** Question categories of a « Mixte » round, in words. */
export const CATEGORY_LABEL_FR: Readonly<Record<string, string>> = {
  choice: "QCM et vrai / faux",
  vote: "vote",
  poll: "sondage",
  oral: "réponse orale",
  text: "réponse libre",
  number: "nombre",
  order: "ordre",
  pairs: "associations",
  pin: "point sur image",
  allocation: "répartition",
};

/** « 200 pts », « 100 → 50 pts (dégressif) », « … · erreur −50 · ×2 ». */
export function ruleSummary(rule: readonly ({ type: "base"; points: number } | { type: "timeDecay"; minPoints: number } | { type: "penalty"; points: number } | { type: "multiplier"; factor: number })[]): string {
  const base = rule.reduce((t, c) => (c.type === "base" ? t + c.points : t), 0);
  const decay = rule.find((c) => c.type === "timeDecay");
  const penalty = rule.reduce((t, c) => (c.type === "penalty" ? t + c.points : t), 0);
  const mult = rule.reduce((f, c) => (c.type === "multiplier" ? f * c.factor : f), 1);
  let out = decay !== undefined && decay.type === "timeDecay" && decay.minPoints !== base ? `${base} → ${decay.minPoints} pts (dégressif)` : `${base} pts`;
  if (penalty !== 0) out += ` · erreur −${Math.abs(penalty)}`;
  if (mult !== 1) out += ` · ×${mult}`;
  return out;
}

/** Points decided by the mechanic itself, in words. */
export const OWN_POINTS_FR: Readonly<Record<string, string>> = {
  "poll-board": "% des réponses trouvées",
  allocation: "mise posée sur la bonne réponse",
  ladder: "gain du palier atteint",
  board: "valeur de la case",
  hints: "selon le nombre d'indices",
  "reveal-image": "selon les cases dévoilées",
  "crowd-vote": "points du vote du chat",
  chain: "banque, versée au vainqueur du duel",
};

