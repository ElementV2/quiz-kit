import type { Action, ChainMechanicView, ControlView } from "@quiz/schema";

/**
 * The single "next step" key (doc 08: space bar, Companion `/next`, OSC `/quiz/next`): the natural next control
 * action for the current phase. Shared by the control room, the driving host and the external control API so they
 * always agree. `action: null` = nothing to send yet: the key is greyed and its label says what to do first
 * (« D'abord : Juste ou Faux »); the external API answers that label as its error.
 */
export type NextStep = { readonly label: string; readonly action: Action | null };

type Viewable = Pick<ControlView, "phase" | "round" | "nextQuestion" | "mechanic">;

const CHAIN_ON_AIR = new Set(["presenting", "open", "locked", "judging"]);

export function nextStep(v: Viewable): NextStep | null {
  const chain = v.mechanic?.mechanic === "chain" ? chainStep(v, v.mechanic) : undefined;
  if (chain !== undefined) return chain;
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

/**
 * « La chaîne » (ADR-0016): answers are spoken and judged on air (no open / lock / reveal needed), the vote comes
 * between rounds. `undefined` = nothing specific here (the generic step applies).
 */
function chainStep(v: Viewable, m: ChainMechanicView): NextStep | null | undefined {
  const won = (m.duel?.winner ?? null) !== null;
  const finished = m.over !== null || won;
  const last = v.round !== null && v.round.index + 1 >= v.round.count;
  const end: NextStep = { label: endLabel(m.stage, won, last), action: { type: "question.next" } };
  if (CHAIN_ON_AIR.has(v.phase)) {
    if (finished) return end;
    // The player on turn was removed: nobody answers this question, move on.
    if (m.turn === null) return { label: "Question suivante", action: { type: "question.next" } };
    if (m.verdict === null) return { label: "D'abord : Juste ou Faux", action: null };
    return { label: "Question suivante", action: { type: "question.next" } };
  }
  if (v.phase === "revealed") return finished ? end : undefined;
  if (v.phase !== "idle" && v.phase !== "round.end") return undefined;
  // Between rounds: the elimination vote comes before the next round (a vote open or tied blocks it).
  if (m.vote?.status === "open") {
    return m.vote.cast === 0
      ? { label: "Clore le vote : aucun vote reçu", action: null }
      : { label: `Clore le vote (${m.vote.cast}/${m.vote.voters.length} votes)`, action: { type: "chain.closeVote" } };
  }
  if (m.vote?.status === "tie") return { label: "Égalité : le maillon fort départage", action: null };
  if (m.canOpenVote) return { label: "Ouvrir le vote d'élimination", action: { type: "chain.openVote" } };
  return undefined;
}

function endLabel(stage: ChainMechanicView["stage"], won: boolean, last: boolean): string {
  if (stage === "chain") return "Fin de la manche";
  if (!won) return last ? "Fin de la partie (duel sans vainqueur)" : "Fin du duel (sans vainqueur)";
  return last ? "Fin de la partie : la cagnotte au vainqueur" : "Fin du duel : la cagnotte au vainqueur";
}
