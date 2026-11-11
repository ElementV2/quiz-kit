import type { Action, ControlView } from "@quiz/schema";

/**
 * The single "next step" key (doc 08: space bar, Companion `/next`, OSC `/quiz/next`): the natural next control
 * action for the current phase. Shared by the control room and the external control API so both always agree.
 */
export function nextStep(v: Pick<ControlView, "phase" | "round" | "nextQuestion" | "mechanic">): { label: string; action: Action } | null {
  switch (v.phase) {
    case "lobby":
      return { label: "Démarrer la partie", action: { type: "game.start" } };
    case "idle":
      if (v.round === null) return { label: "Démarrer la manche", action: { type: "round.start" } };
      // Board: between two cells the view carries the grid; without index the first free cell is played.
      if (v.mechanic?.mechanic === "board") return { label: "Case suivante", action: { type: "question.present" } };
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
