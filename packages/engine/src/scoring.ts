import type { ScoringRule } from "@quiz/schema";
import type { Judgement } from "./mechanic.ts";
import { assertNever } from "./result.ts";

export type ScoringWindow = {
  /** When answers opened (server ms). */
  readonly openedAt: number;
  /** Timer duration, if any: timeDecay needs it. */
  readonly durationMs: number | null;
};

/**
 * Points for one judgement (doc 02 ScoringRule). Deterministic, integer result.
 * - correct: base, minus linear timeDecay down to minPoints over the window, times multipliers.
 * - wrong:   penalty (≤ 0) times multipliers, 0 if no penalty component.
 */
export function pointsFor(rule: ScoringRule, j: Extract<Judgement, { kind: "rule" }>, w: ScoringWindow): number {
  let base = 0;
  let penalty = 0;
  let factor = 1;
  let minPoints: number | null = null;
  for (const c of rule) {
    switch (c.type) {
      case "base":
        base += c.points;
        break;
      case "penalty":
        penalty += c.points;
        break;
      case "multiplier":
        factor *= c.factor;
        break;
      case "timeDecay":
        minPoints = c.minPoints;
        break;
      default:
        return assertNever(c);
    }
  }
  if (j.outcome === "wrong") return roundHalfAway(penalty * factor);
  let points = base;
  if (minPoints !== null && w.durationMs !== null && w.durationMs > 0) {
    const elapsed = Math.min(Math.max(j.answeredAt - w.openedAt, 0), w.durationMs);
    points = base - ((base - minPoints) * elapsed) / w.durationMs;
  }
  return roundHalfAway(points * factor);
}

/** Symmetric rounding (7.5 → 8, -7.5 → -8), never -0. Shared by mechanics computing their own points. */
export function roundHalfAway(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r;
}
