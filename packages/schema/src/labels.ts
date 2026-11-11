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
  scorer: "le poste scores",
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
  waiting: "en attente",
  substitute: "remplaçant",
  disconnected: "déconnecté",
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
  "crowd.tally": "compter les votes du chat",
  "score.adjust": "corriger un score",
  "score.setTotal": "fixer un total",
  "score.void": "annuler une ligne de score",
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
