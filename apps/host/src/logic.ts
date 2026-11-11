import { nextTarget, onAirTarget, questionAt, sameTarget, type RundownQuestion, type RundownRound, type Target } from "@quiz/ui";
import type { Action, HostView } from "@quiz/schema";

/**
 * Host prompter logic (pure, unit-tested): WHICH question to read and what the drive keys offer. It only
 * locates questions and maps a tap to intents; the engine accepts or refuses every intent.
 */

/** `onair`: on screen; `next`: not on air yet, to read ahead; `preview`: picked in the run-down. */
export type ReadMode = "onair" | "next" | "preview";
export type Reading = { readonly mode: ReadMode; readonly target: Target; readonly round: RundownRound; readonly question: RundownQuestion };

export function reading(v: HostView, preview: Target | null): Reading | null {
  const air = onAirTarget(v);
  const pick = (mode: ReadMode, t: Target | null): Reading | null => {
    const q = questionAt(v.rundown, t);
    const r = t === null ? undefined : v.rundown[t.roundIndex];
    return t === null || q === null || r === undefined ? null : { mode, target: t, round: r, question: q };
  };
  if (preview !== null && !sameTarget(preview, air)) {
    const p = pick("preview", preview);
    if (p !== null) return p;
  }
  return air !== null ? pick("onair", air) : pick("next", nextTarget(v));
}

/** What « Présenter celle-ci » does for a question picked in the run-down (drive mode only). */
export type PresentOffer = { readonly ok: true; readonly label: string; readonly steps: readonly Action[]; readonly confirm: string | null } | { readonly ok: false; readonly reason: string };

export function presentOffer(v: HostView, t: Target, played: boolean): PresentOffer {
  if (!v.drive) return { ok: false, reason: "La régie pilote." };
  if (v.phase === "game.end") return { ok: false, reason: "La partie est terminée." };
  if (onAirTarget(v) !== null) return { ok: false, reason: "Une question est à l'antenne : passez-la ou terminez-la d'abord." };
  const present: Action = { type: "question.present", questionIndex: t.questionIndex };
  const confirm = played ? "Déjà jouée : la rejouer ?" : null;
  if (v.phase === "lobby") return { ok: true, label: "Lancer la partie sur celle-ci", steps: [{ type: "game.start" }, { type: "round.start", roundIndex: t.roundIndex }, present], confirm };
  if (v.round?.index === t.roundIndex && v.phase === "idle") return { ok: true, label: "Présenter celle-ci", steps: [present], confirm };
  // Another round: start it, then present (the engine refuses a jump that skips questions without roundIndex).
  return { ok: true, label: "Démarrer sa manche et la présenter", steps: [{ type: "round.start", roundIndex: t.roundIndex }, present], confirm };
}

/** Seconds as a timecode (`0:07`, `1:30`). */
export function timecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
