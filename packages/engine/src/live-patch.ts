import { answerKindLabel, mechanicLabel, type GameDocument } from "@quiz/schema";
import type { GameState } from "./state.ts";

/**
 * Editing the live game (`game.patch`, doc 07 « modifier en direct »): what the studio may change while a show
 * runs, without breaking what was played or what is on air. Returns why a patch is refused, or null.
 * Allowed: new rounds / questions, edits of questions not played yet, look (theme, scenes), title, limits that
 * still fit the players present. Refused: removing or reordering what was played, changing the round or the
 * answer of the question on air (use `question.regrade` / `question.edit` for that).
 */
/** A question with its wording and host notes blanked: what must not change once it is on air / played. */
const frozenPart = (q: GameDocument["questions"][number]): string => JSON.stringify({ ...q, notes: "", prompt: { ...q.prompt, text: "" } });

export function livePatchProblem(s: GameState, next: GameDocument, freeOrder = false): string | null {
  const cur = s.game;
  if (next.format.participants.max < s.participants.length) {
    return `la partie a ${s.participants.length} joueur(s) : le maximum ne peut pas descendre à ${next.format.participants.max}`;
  }
  if (next.format.participants.mode !== cur.format.participants.mode && s.participants.length > 0) {
    return "des joueurs sont déjà là : la partie ne passe plus d'équipes à solo (ou l'inverse)";
  }
  const byId = new Map(next.questions.map((q) => [q.id, q]));
  // Every question already revealed stays, with its answer (history, results, regrade decide from it).
  for (const h of s.history) {
    const before = cur.questions.find((q) => q.id === h.questionId);
    const after = byId.get(h.questionId);
    if (after === undefined) return `la question jouée « ${before?.prompt.text ?? h.questionId} » ne peut pas être supprimée`;
    if (before !== undefined && JSON.stringify(before.answerSpec) !== JSON.stringify(after.answerSpec)) {
      return `la réponse de la question jouée « ${before.prompt.text} » ne change pas ici : utiliser « Corriger la réponse » en régie`;
    }
    // Media, hints, tags… of a played question are what results and replay show: only its wording / notes change.
    if (before !== undefined && frozenPart(before) !== frozenPart(after)) return `la question jouée « ${before.prompt.text} » ne change plus que par son texte`;
  }
  if (s.roundIndex === null) return null; // nothing started: anything goes
  // Rounds already started keep their place and their kind.
  for (let i = 0; i <= s.roundIndex; i++) {
    const before = cur.format.rounds[i];
    const after = next.format.rounds[i];
    if (before === undefined) continue;
    if (after === undefined || after.id !== before.id) return `la manche « ${before.title} » est déjà jouée ou en cours : elle doit rester à sa place (ajouter les nouvelles manches après)`;
    if (after.mechanic !== before.mechanic) return `la manche « ${before.title} » est en cours : son type (« ${mechanicLabel(before.mechanic)} ») ne peut pas changer`;
    // The scoring of a round already started is frozen: a later regrade must score like the reveal did.
    if (JSON.stringify(after.scoring) !== JSON.stringify(before.scoring)) return `le barème de la manche « ${before.title} » (déjà commencée) ne change plus`;
  }
  const round = cur.format.rounds[s.roundIndex];
  const nextRound = next.format.rounds[s.roundIndex];
  if (round === undefined || nextRound === undefined) return null;
  if (JSON.stringify(round.mechanicConfig) !== JSON.stringify(nextRound.mechanicConfig) && s.questionIndex !== null) {
    return `la manche « ${round.title} » est en cours : ses réglages ne changent qu'avant sa première question`;
  }
  // Questions already presented keep their place. Free order (board): cells are played in any order, so the
  // whole grid stays as it is — new questions only at the end.
  if (freeOrder && nextRound.questions.length !== round.questions.length) {
    return `plateau « ${round.title} » en cours : la grille ne change plus (ajouter les cases dans une nouvelle manche)`;
  }
  if (freeOrder) {
    // Columns (first tag), values and the cell count come from the cells themselves: frozen while the board runs.
    for (const id of round.questions) {
      const before = cur.questions.find((q) => q.id === id);
      const after = byId.get(id);
      if (before !== undefined && (after === undefined || frozenPart(before) !== frozenPart(after))) {
        return `plateau « ${round.title} » en cours : ses cases ne changent plus que par leur texte`;
      }
    }
  }
  const upTo = freeOrder ? round.questions.length - 1 : (s.questionIndex ?? -1);
  for (let qi = 0; qi <= upTo; qi++) {
    if (nextRound.questions[qi] !== round.questions[qi]) {
      return freeOrder
        ? `plateau « ${round.title} » en cours : les cases restent à leur place`
        : `les questions déjà présentées de « ${round.title} » doivent rester à leur place (ajouter ou modifier les suivantes)`;
    }
  }
  // The question on air: only its text may change (image, options, hints… are in the mechanic state already).
  const onAirId = s.mechanic !== null && s.questionIndex !== null ? round.questions[s.questionIndex] : undefined;
  if (onAirId !== undefined) {
    const before = cur.questions.find((q) => q.id === onAirId);
    const after = byId.get(onAirId);
    if (before !== undefined && after !== undefined && frozenPart(before) !== frozenPart(after)) {
      return `la question à l'antenne ne change que par son texte (« ${answerKindLabel(before.answerSpec.kind)} » : réponse, image, propositions figées) — « Corriger la réponse » en régie pour la réponse`;
    }
  }
  return null;
}
