import type { FixedJudgement, Judgement } from "./mechanic.ts";

/** A verdict forced by the control room for one participant on one question (cheating, manual correction). */
export type ForcedVerdict = { readonly participantId: string; readonly correct: boolean };

/**
 * The mechanic's judgements with the forced verdicts applied (pure). Rule-scored judgements take the forced
 * outcome; a participant forced right who has no judgement (no answer, or judged by nobody) gets one, as if they
 * answered at the opening (full points of the round's rule). Points decided by the mechanic (`fixed`) can only be
 * taken away (forced wrong → 0): forcing them right is refused upstream (`ownPoints`).
 */
export function applyVerdicts(judgements: readonly Judgement[], forced: readonly ForcedVerdict[], openedAt: number): Judgement[] {
  if (forced.length === 0) return [...judgements];
  const byId = new Map(forced.map((f) => [f.participantId, f.correct]));
  const seen = new Set<string>();
  const out: Judgement[] = judgements.map((j): Judgement => {
    if (j.kind === "rule") {
      const f = byId.get(j.participantId);
      seen.add(j.participantId);
      return f === undefined ? j : { ...j, outcome: f ? "correct" : "wrong" };
    }
    if (!("participantId" in j.target)) return j;
    const f = byId.get(j.target.participantId);
    seen.add(j.target.participantId);
    return f === false ? ({ ...j, outcome: "wrong", points: 0 } satisfies FixedJudgement) : j;
  });
  for (const f of forced) if (f.correct && !seen.has(f.participantId)) out.push({ kind: "rule", participantId: f.participantId, outcome: "correct", answeredAt: openedAt });
  return out;
}

/** The automatic verdict of each participant judged by the mechanic (rule / per-participant fixed judgements). */
export function autoVerdicts(judgements: readonly Judgement[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const j of judgements) {
    if (j.kind === "rule") out.set(j.participantId, j.outcome === "correct");
    else if ("participantId" in j.target) out.set(j.target.participantId, j.outcome === "correct" && j.points > 0);
  }
  return out;
}
