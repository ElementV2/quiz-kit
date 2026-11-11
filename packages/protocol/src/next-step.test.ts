import { describe, expect, it } from "vitest";
import { ChainMechanicView } from "@quiz/schema";
import { nextStep } from "./next-step.ts";

/** A chain view as the engine projects it between two rounds (only what `nextStep` reads matters). */
const chain = (over: Partial<ChainMechanicView> = {}): ChainMechanicView =>
  ChainMechanicView.parse({
    mechanic: "chain", roundIndex: 0, stage: "chain", order: ["p_1", "p_2", "p_3"], turn: null, expected: null, verdict: null, steps: [10, 20], level: 0,
    chainValue: 0, bank: 10, bankTarget: 20, totalBank: 10, over: "ended", stats: [], strongest: null, weakest: null, vote: null,
    canOpenVote: false, eliminations: [], duel: null, ...over,
  });

const vote = (status: "open" | "tie" | "done"): NonNullable<ChainMechanicView["vote"]> => ({ status, voters: ["p_1", "p_2", "p_3"], cast: 0, ballots: null, tally: null, tied: [], picker: null, eliminated: null, myVote: null });
const round = { index: 0, count: 3, title: "Chaîne 1" };

describe("nextStep — « La chaîne » between rounds", () => {
  it("proposes the elimination vote before the next round, then closes it", () => {
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain({ canOpenVote: true }) })?.action).toEqual({ type: "chain.openVote" });
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain({ vote: { ...vote("open"), cast: 2 } }) })).toEqual({ label: "Clore le vote (2/3 votes)", action: { type: "chain.closeVote" } });
  });

  it("waits for the strongest link on a tie, and for a first ballot before closing (greyed key with its reason)", () => {
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain({ vote: vote("tie") }) })).toEqual({ label: "Égalité : le maillon fort départage", action: null });
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain({ vote: vote("open") }) })).toEqual({ label: "Clore le vote : aucun vote reçu", action: null });
  });

  it("goes to the next round once the vote is done (or when no vote can be held)", () => {
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain({ vote: vote("done") }) })?.action).toEqual({ type: "round.start" });
    expect(nextStep({ phase: "round.end", round, nextQuestion: null, mechanic: chain() })?.action).toEqual({ type: "round.start" });
  });

  it("between two turns of a chain round, presents the next question", () => {
    const next = { id: "q_ch1_2", text: "?" };
    expect(nextStep({ phase: "idle", round, nextQuestion: next, mechanic: chain({ over: null }) })?.action).toEqual({ type: "question.present" });
  });
});

const onAir = (over: Partial<ChainMechanicView>, phase: "presenting" | "open" | "revealed" = "presenting", r = round) =>
  nextStep({ phase, round: r, nextQuestion: null, mechanic: chain({ over: null, turn: "p_1", ...over }) });

describe("nextStep — « La chaîne » on air (Companion / OSC / HTTP `next` = the control room's key)", () => {

  it("never opens / locks / reveals: judge first (greyed), then the next question", () => {
    expect(onAir({})).toEqual({ label: "D'abord : Juste ou Faux", action: null });
    expect(onAir({}, "open")?.action).toBeNull();
    expect(onAir({ verdict: "wrong" })).toEqual({ label: "Question suivante", action: { type: "question.next" } });
    expect(onAir({}, "revealed")?.action).toEqual({ type: "question.next" });
  });

  it("the player on turn was removed: move on rather than wait for a judgement", () => {
    expect(onAir({ turn: null })).toEqual({ label: "Question suivante", action: { type: "question.next" } });
  });

  it("a finished chain round / duel ends the round, saying whether the bank is paid", () => {
    expect(onAir({ over: "target" })).toEqual({ label: "Fin de la manche", action: { type: "question.next" } });
    const last = { index: 2, count: 3, title: "Duel final" };
    const duel = { stage: "duel" as const, steps: [] };
    expect(onAir({ ...duel, duel: { questionsEach: 5, suddenDeath: false, winner: "p_1" } }, "presenting", last)?.label).toBe("Fin de la partie : la cagnotte au vainqueur");
    expect(onAir({ ...duel, over: "ended", duel: { questionsEach: 5, suddenDeath: false, winner: null } }, "presenting", last)?.label).toBe("Fin de la partie (duel sans vainqueur)");
    expect(onAir({ ...duel, over: "ended", duel: { questionsEach: 5, suddenDeath: false, winner: null } })?.label).toBe("Fin du duel (sans vainqueur)");
  });
});
