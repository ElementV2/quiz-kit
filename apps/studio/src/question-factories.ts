import type { AnswerKind, AnswerSpec, GameDocument, NormRect, Question } from "@quiz/schema";

/** Question bank (Content tab): the "+ question" menu and starting content per answer kind. Pure, tested. */

export const QUESTION_TYPES: readonly { readonly kind: AnswerKind; readonly label: string; readonly help: string }[] = [
  { kind: "single", label: "QCM", help: "une seule bonne réponse parmi 2 à 6" },
  { kind: "boolean", label: "Vrai / faux", help: "une affirmation, vraie ou fausse" },
  { kind: "multi", label: "Plusieurs réponses", help: "plusieurs bonnes réponses à cocher" },
  { kind: "text", label: "Réponse libre", help: "le joueur tape sa réponse" },
  { kind: "number", label: "Nombre", help: "une estimation, avec tolérance" },
  { kind: "order", label: "Remettre dans l'ordre", help: "3 à 8 éléments à classer" },
  { kind: "pairs", label: "Associations", help: "relier gauche et droite" },
  { kind: "pin", label: "Pin sur image", help: "poser un point dans une zone de l'image" },
  { kind: "allocation", label: "Répartition", help: "répartir une mise entre les réponses" },
  { kind: "oral", label: "Oral (buzzer / plateau)", help: "réponse dite à voix haute, validée par la régie" },
  { kind: "poll", label: "Sondage %", help: "réponses d'un sondage avec leur pourcentage" },
];

export const kindLabel = (k: AnswerKind): string => QUESTION_TYPES.find((t) => t.kind === k)?.label ?? k;

const opt = (id: string, label: string, value?: number) => (value === undefined ? { id, label } : { id, label, value });

const SPECS: { readonly [K in AnswerKind]: () => Extract<AnswerSpec, { kind: K }> } = {
  single: () => ({ kind: "single", correct: "a", options: [opt("a", "Réponse A"), opt("b", "Réponse B"), opt("c", "Réponse C"), opt("d", "Réponse D")] }),
  multi: () => ({ kind: "multi", correct: ["a", "b"], options: [opt("a", "Réponse A"), opt("b", "Réponse B"), opt("c", "Réponse C"), opt("d", "Réponse D")] }),
  boolean: () => ({ kind: "boolean", correct: true }),
  text: () => ({ kind: "text", accepted: ["Réponse"] }),
  number: () => ({ kind: "number", correct: 100, tolerance: 0 }),
  order: () => ({ kind: "order", options: [opt("a", "Premier"), opt("b", "Deuxième"), opt("c", "Troisième")] }),
  pairs: () => ({ kind: "pairs", pairs: [{ id: "p1", left: "Gauche 1", right: "Droite 1" }, { id: "p2", left: "Gauche 2", right: "Droite 2" }] }),
  pin: () => ({ kind: "pin", target: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }),
  allocation: () => ({ kind: "allocation", correct: "a", budget: 1000, options: [opt("a", "Réponse A"), opt("b", "Réponse B"), opt("c", "Réponse C")] }),
  oral: () => ({ kind: "oral", expected: "Réponse attendue" }),
  poll: () => ({ kind: "poll", options: [opt("a", "Réponse 1", 40), opt("b", "Réponse 2", 30), opt("c", "Réponse 3", 20)] }),
};

export const newAnswerSpec = (kind: AnswerKind): AnswerSpec => SPECS[kind]();

const PROMPT: Record<AnswerKind, string> = {
  single: "Nouvelle question ?",
  multi: "Lesquelles sont justes ?",
  boolean: "Affirmation ?",
  text: "Nouvelle question ?",
  number: "Combien… ?",
  order: "Remettez dans l'ordre :",
  pairs: "Associez :",
  pin: "Où se trouve… ?",
  allocation: "Où placez-vous votre mise ?",
  oral: "Nouvelle question ?",
  poll: "Nous avons demandé à 100 personnes…",
};

export function newQuestion(kind: AnswerKind, id: string): Question {
  return { id, prompt: { text: PROMPT[kind] }, answerSpec: newAnswerSpec(kind), hints: [], tags: [] };
}

/** First free option id (a, b, … z, then o27…), unique within the question. */
export function freeOptionId(taken: readonly string[]): string {
  for (const c of "abcdefghijklmnopqrstuvwxyz") if (!taken.includes(c)) return c;
  let i = 27;
  while (taken.includes(`o${i}`)) i++;
  return `o${i}`;
}

const c = (v: number): number => Math.min(1, Math.max(0, v));
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** Pin target from a drag on the image preview, in normalised coordinates (0..1), clamped and never empty. */
export function normRectFromDrag(a: { x: number; y: number }, b: { x: number; y: number }): NormRect {
  const x0 = c(Math.min(a.x, b.x));
  const y0 = c(Math.min(a.y, b.y));
  const w = Math.max(0.01, c(Math.max(a.x, b.x)) - x0);
  const h = Math.max(0.01, c(Math.max(a.y, b.y)) - y0);
  return { x: r4(Math.min(x0, 1 - w)), y: r4(Math.min(y0, 1 - h)), w: r4(w), h: r4(h) };
}

/** Hints / tags typed one per line or comma separated → clean list. */
export function splitList(text: string, sep: RegExp): string[] {
  return text.split(sep).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * A new, empty game: one round and one blank question to write (a game needs at least one question to be valid,
 * so it can be saved, listed and launched at once). No demo content.
 */
export function blankGame(suffix: string): GameDocument {
  const q = { ...newQuestion("single", `q_${suffix}`), prompt: { text: "Écrivez votre première question" } };
  return {
    schemaVersion: 1,
    title: "Nouvelle partie",
    questions: [q],
    scenes: [],
    format: {
      id: `f_${suffix}`,
      name: "Nouvelle partie",
      participants: { mode: "solo", min: 1, max: 500 },
      tieBreak: "control",
      rounds: [{ id: `r_${suffix}`, title: "Manche 1", mechanic: "choice", mechanicConfig: {}, questions: [q.id], reserve: [], timer: { durationMs: 20_000, autoLock: true }, scoring: [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }] }],
    },
  };
}
