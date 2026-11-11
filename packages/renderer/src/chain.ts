import type { MechanicView, Phase } from "@quiz/schema";

/**
 * « La chaîne » (chain, ADR-0016): pure reading helpers of the projected `ChainMechanicView`, shared by the output
 * zones, the control room, the host and the tablets. No rule here: every figure is read off the view.
 */

export type ChainView = Extract<MechanicView, { mechanic: "chain" }>;
export const asChain = (m: MechanicView | null | undefined): ChainView | null => (m?.mechanic === "chain" ? m : null);

/**
 * Between two rounds the view still carries the chain of the round just played, until the next round presents its
 * first question (`roundIndex` of the view vs the current round): its figures and its vote are history, not news.
 */
export const chainOfEarlierRound = (m: Pick<ChainView, "roundIndex">, round: { readonly index: number } | null): boolean => round !== null && m.roundIndex !== round.index;

/** State of one step of the chain: climbed (below), current (what banking now puts in the bank), next (a right answer reaches it). */
export type ChainStepState = "climbed" | "current" | "next" | "idle";

/** Steps top-down (highest first), each with its state. */
export function chainSteps(m: Pick<ChainView, "steps" | "level">): { readonly index: number; readonly amount: number; readonly state: ChainStepState }[] {
  const stateOf = (index: number): ChainStepState => (index === m.level - 1 ? "current" : index < m.level ? "climbed" : index === m.level ? "next" : "idle");
  return m.steps.map((amount, index) => ({ index, amount, state: stateOf(index) })).toReversed();
}

/** Why the chain round stopped, in words. */
export function chainOverText(over: ChainView["over"]): string | null {
  switch (over) {
    case "target":
      return "Banque pleine : la manche est finie";
    case "questions":
      return "Plus de questions : la manche est finie";
    case "ended":
      return "Temps écoulé : la manche est finie";
    case null:
      return null;
    default: {
      const unknown: never = over;
      return unknown;
    }
  }
}

/** Votes received, most first (null while the vote is secret for this audience). */
export function chainTally(m: ChainView): readonly { readonly participantId: string; readonly votes: number }[] | null {
  return m.vote?.tally ?? null;
}

/** Duel score of each of the two players (right answers, questions asked), in turn order. */
export function duelScores(m: ChainView): { readonly participantId: string; readonly right: number; readonly asked: number }[] {
  return m.order.map((id) => {
    const s = m.stats.find((x) => x.participantId === id);
    return { participantId: id, right: s?.right ?? 0, asked: (s?.right ?? 0) + (s?.wrong ?? 0) };
  });
}

/** A judged answer on air: the turn is played (the next step is the next question). */
export const chainJudged = (m: ChainView): boolean => m.verdict !== null;

/** The chain round or the duel is over: « Suivante » ends the round. */
export const chainFinished = (m: ChainView): boolean => m.over !== null || (m.duel?.winner ?? null) !== null;

const ON_AIR: ReadonlySet<Phase> = new Set(["presenting", "open", "locked", "judging"]);

/** May the player on turn bank now (before their answer is judged, something at stake, a chain round still going)? */
export function chainCanBank(m: ChainView, phase: Phase): boolean {
  return m.stage === "chain" && m.turn !== null && m.verdict === null && m.over === null && m.chainValue > 0 && ON_AIR.has(phase);
}
