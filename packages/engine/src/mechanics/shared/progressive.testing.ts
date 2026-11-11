import type { Action } from "@quiz/schema";

/** Test-only generators shared by the hints and reveal-image contract suites. */

export const progressiveAnswer = (picks: readonly number[], pid: string, m: { input: "text" | "choice"; correct: string | null; options: { id: string }[] | null }): Action => {
  const right = (picks[0] ?? 0) % 2 === 0;
  if (m.input === "text") return { type: "answer.submit", participantId: pid, answer: { kind: "text", text: right && m.correct !== null ? m.correct : "Personne" } };
  const ids = (m.options ?? []).map((o) => o.id);
  return { type: "answer.submit", participantId: pid, answer: { kind: "choice", optionIds: [right && m.correct !== null ? m.correct : (ids[(picks[1] ?? 0) % Math.max(ids.length, 1)] ?? "a")] } };
};

export const revealNext = (control: { mechanic: unknown }, picks: readonly number[]): Action | null => {
  const m = control.mechanic;
  if (typeof m !== "object" || m === null || !("hintCount" in m || "revealed" in m)) return null;
  const shown = "hintCount" in m && typeof m.hintCount === "number" ? m.hintCount : "revealed" in m && Array.isArray(m.revealed) ? m.revealed.length : 0;
  return (picks[0] ?? 0) % 3 === 0 ? { type: "answer.judge", participantId: "p_1", correct: true } : { type: "element.reveal", index: shown };
};
