import type { SoundCue, View } from "@quiz/schema";

/**
 * Moments (doc 06 « déclenchés par événement moteur ») detected from two consecutive projected views.
 * Pure: the renderer never computes game rules, it only compares what the server already decided.
 */
export type Moment =
  | { readonly kind: "answer.correct" }
  | { readonly kind: "answer.wrong" }
  | { readonly kind: "leader.changed"; readonly leader: string }
  | { readonly kind: "podium" }
  | { readonly kind: "ladder.reached"; readonly level: number }
  | { readonly kind: "buzzer.won" }
  | { readonly kind: "timer.last5" };

// Every moment can carry a theme sound: kinds must stay aligned with the schema's `SoundCue`.
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const cuesAligned: AssertSame<Moment["kind"], SoundCue> = true;
void cuesAligned;

export type EffectsLevel = "full" | "light" | "off";

/** Particle budget per level (AUDIT A11: default `light` until the OBS / vMix bench validates `full`). */
export const PARTICLES: Record<EffectsLevel, number> = { full: 320, light: 90, off: 0 };

export function parseEffectsLevel(raw: string | null | undefined): EffectsLevel {
  return raw === "full" || raw === "off" || raw === "light" ? raw : "light";
}

const correctShown = (v: View): boolean => {
  const m = v.mechanic;
  if (m === null) return false;
  switch (m.mechanic) {
    case "choice":
      return m.correct !== null && m.counts !== null;
    case "ladder":
      return m.correct !== null && m.answer === m.correct;
    case "buzzer":
      return m.winner !== null;
    case "poll-board":
      return m.slots.some((s) => s.found);
    case "board":
      return m.winner !== null;
    case "text-answer":
    case "number-answer":
    case "order":
    case "pairs":
    case "pin":
    case "allocation":
    case "hints":
    case "reveal-image":
      return m.correct !== null;
    case "crowd-vote":
      return m.correct !== null && m.majority?.length === 1 && m.majority[0] === m.correct;
    default:
      return false;
  }
};

export function detectMoments(prev: View | null, next: View, serverNow: number): Moment[] {
  const out: Moment[] = [];
  if (prev === null) return out; // first snapshot (reload): never replay a celebration
  if (prev.question?.id === next.question?.id && next.phase === "revealed" && prev.phase !== "revealed" && correctShown(next)) out.push({ kind: "answer.correct" });
  const pm = prev.mechanic;
  const nm = next.mechanic;
  if (pm?.mechanic === "buzzer" && nm?.mechanic === "buzzer" && pm.winner === null && nm.winner !== null) out.push({ kind: "buzzer.won" });
  if (pm?.mechanic === "board" && nm?.mechanic === "board" && pm.winner === null && nm.winner !== null) out.push({ kind: "buzzer.won" });
  if (pm?.mechanic === "board" && nm?.mechanic === "board" && (nm.lockedOut?.length ?? 0) > (pm.lockedOut?.length ?? 0)) out.push({ kind: "answer.wrong" });
  if (pm?.mechanic === "poll-board" && nm?.mechanic === "poll-board" && nm.slots.filter((s) => s.found).length > pm.slots.filter((s) => s.found).length) out.push({ kind: "answer.correct" });
  if (pm?.mechanic === "ladder" && nm?.mechanic === "ladder" && nm.level > pm.level) out.push({ kind: "ladder.reached", level: nm.level });
  // Wrong answers: a buzzer player locked out, a poll strike, a ladder answer revealed wrong.
  if (pm?.mechanic === "buzzer" && nm?.mechanic === "buzzer" && (nm.lockedOut?.length ?? 0) > (pm.lockedOut?.length ?? 0)) out.push({ kind: "answer.wrong" });
  if (pm?.mechanic === "poll-board" && nm?.mechanic === "poll-board" && nm.strikes > pm.strikes) out.push({ kind: "answer.wrong" });
  if (nm?.mechanic === "ladder" && prev.phase !== "revealed" && next.phase === "revealed" && nm.correct !== null && nm.answer !== null && nm.answer !== nm.correct) out.push({ kind: "answer.wrong" });
  const before = prev.leaderboard[0];
  const after = next.leaderboard[0];
  if (before !== undefined && after !== undefined && before.participantId !== after.participantId && after.total > 0) out.push({ kind: "leader.changed", leader: after.displayName });
  if (prev.phase !== "game.end" && next.phase === "game.end") out.push({ kind: "podium" });
  if (next.timer !== null && prev.timer !== null && next.timer.endsAt === prev.timer.endsAt) {
    const left = next.timer.endsAt - serverNow;
    if (left <= 5000 && left > 4000) out.push({ kind: "timer.last5" });
  }
  return out;
}
