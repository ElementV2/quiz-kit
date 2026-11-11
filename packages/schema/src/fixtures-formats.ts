import type { Question } from "./content.ts";
import type { Round } from "./format.ts";
import type { GameDocument } from "./session.ts";

/**
 * Phase 3 demo content: one game per mechanic (tests, templates) and a multi-round evening that mixes them.
 * Original questions only.
 */

const NOTE = "Fiche animateur : ne jamais afficher.";

const q = (id: string, text: string, answerSpec: Question["answerSpec"], extra: Partial<Question> = {}): Question => ({
  id,
  prompt: { text },
  answerSpec,
  hints: [],
  tags: [],
  notes: `${NOTE} (${id})`,
  ...extra,
});

const BASE_SCORING: Round["scoring"] = [{ type: "base", points: 100 }, { type: "timeDecay", minPoints: 50 }];

const solo = (title: string, questions: Question[], rounds: Round[]): GameDocument => ({
  schemaVersion: 1,
  title,
  scenes: [],
  questions,
  format: { id: `f_${rounds[0]?.mechanic.replaceAll("-", "_") ?? "x"}`, name: title, participants: { max: 500 }, tieBreak: "speed", rounds },
});

export const TEXT_QUESTIONS: Question[] = [
  q("q_txt_1", "Quel peintre a réalisé « La Nuit étoilée » ?", { kind: "text", accepted: ["Vincent van Gogh", "Van Gogh"] }),
  q("q_txt_2", "Quelle est la capitale de l'Australie ?", { kind: "text", accepted: ["Canberra"] }),
  q("q_txt_3", "En quelle année a eu lieu la prise de la Bastille ?", { kind: "text", accepted: ["1789"] }),
];

export const NUMBER_QUESTIONS: Question[] = [
  q("q_num_1", "Combien d'os compte le squelette d'un adulte ?", { kind: "number", correct: 206, tolerance: 0, min: 0, max: 1000 }),
  q("q_num_2", "Hauteur de la tour Eiffel (en mètres, antennes comprises) ?", { kind: "number", correct: 330, tolerance: 10, unit: "m", min: 0, max: 2000 }),
];

export const ORDER_QUESTIONS: Question[] = [
  q("q_ord_1", "Du plus ancien au plus récent :", {
    kind: "order",
    options: [
      { id: "a", label: "Invention de l'imprimerie" },
      { id: "b", label: "Découverte de l'Amérique" },
      { id: "c", label: "Révolution française" },
      { id: "d", label: "Premier pas sur la Lune" },
    ],
  }),
  q("q_ord_2", "Du plus petit au plus grand :", {
    kind: "order",
    options: [
      { id: "a", label: "Mercure" },
      { id: "b", label: "Mars" },
      { id: "c", label: "Terre" },
      { id: "d", label: "Jupiter" },
    ],
  }),
];

export const PAIRS_QUESTIONS: Question[] = [
  q("q_pair_1", "Associez chaque pays à sa capitale", {
    kind: "pairs",
    pairs: [
      { id: "p1", left: "Japon", right: "Tokyo" },
      { id: "p2", left: "Canada", right: "Ottawa" },
      { id: "p3", left: "Brésil", right: "Brasília" },
      { id: "p4", left: "Kenya", right: "Nairobi" },
    ],
  }),
];

export const ALLOCATION_QUESTIONS: Question[] = [
  q("q_alloc_1", "Quel est le plus long fleuve de France ?", {
    kind: "allocation",
    budget: 10_000,
    correct: "b",
    options: [
      { id: "a", label: "Le Rhône" },
      { id: "b", label: "La Loire" },
      { id: "c", label: "La Seine" },
      { id: "d", label: "La Garonne" },
    ],
  }),
];

export const BOARD_QUESTIONS: Question[] = [
  q("q_brd_1", "Ce métal est liquide à température ambiante.", { kind: "oral", expected: "Le mercure" }, { tags: ["Sciences"] }),
  q("q_brd_2", "Nombre de chromosomes d'une cellule humaine.", { kind: "oral", expected: "46" }, { tags: ["Sciences"] }),
  q("q_brd_3", "Cet océan borde la côte ouest de la France.", { kind: "oral", expected: "L'Atlantique" }, { tags: ["Géographie"] }),
  q("q_brd_4", "Plus haut sommet d'Afrique.", { kind: "oral", expected: "Le Kilimandjaro" }, { tags: ["Géographie"] }),
  q("q_brd_5", "Auteur des « Misérables ».", { kind: "oral", expected: "Victor Hugo" }, { tags: ["Lettres"] }),
  q("q_brd_6", "Poète des « Fleurs du mal ».", { kind: "oral", expected: "Charles Baudelaire" }, { tags: ["Lettres"] }),
];

export const HINT_QUESTIONS: Question[] = [
  q("q_hint_1", "Qui suis-je ?", { kind: "text", accepted: ["Marie Curie", "Curie"] }, { hints: ["Je suis née à Varsovie.", "J'ai reçu deux prix Nobel.", "J'ai découvert le polonium et le radium."] }),
  q("q_hint_2", "Quel est ce pays ?", { kind: "single", correct: "c", options: [{ id: "a", label: "Chili" }, { id: "b", label: "Pérou" }, { id: "c", label: "Égypte" }, { id: "d", label: "Mexique" }] }, { hints: ["Son fleuve est l'un des plus longs du monde.", "Sa capitale est Le Caire.", "On y trouve les pyramides de Gizeh."] }),
];

const round = (id: string, title: string, mechanic: string, questions: Question[], extra: Partial<Round> = {}): Round => ({
  id,
  title,
  mechanic,
  mechanicConfig: {},
  questions: questions.map((x) => x.id),
  reserve: [],
  scoring: BASE_SCORING,
  ...extra,
});

export const DEMO_TEXT_GAME = solo("Démo réponse libre", TEXT_QUESTIONS, [round("r_text", "Réponse libre", "text-answer", TEXT_QUESTIONS, { timer: { durationMs: 30_000, autoLock: true } })]);
export const DEMO_NUMBER_GAME = solo("Démo estimation", NUMBER_QUESTIONS, [round("r_number", "Estimation", "number-answer", NUMBER_QUESTIONS, { mechanicConfig: { mode: "closest" } })]);
export const DEMO_ORDER_GAME = solo("Démo remise en ordre", ORDER_QUESTIONS, [round("r_order", "Remettre dans l'ordre", "order", ORDER_QUESTIONS)]);
export const DEMO_PAIRS_GAME = solo("Démo associations", PAIRS_QUESTIONS, [round("r_pairs", "Associations", "pairs", PAIRS_QUESTIONS)]);
export const DEMO_ALLOCATION_GAME = solo("Démo répartition", ALLOCATION_QUESTIONS, [round("r_alloc", "Répartition", "allocation", ALLOCATION_QUESTIONS, { scoring: [{ type: "base", points: 0 }] })]);
export const DEMO_BOARD_GAME = solo("Démo plateau", BOARD_QUESTIONS, [round("r_board", "Plateau", "board", BOARD_QUESTIONS, { mechanicConfig: { values: [200, 400] }, scoring: [{ type: "base", points: 0 }] })]);
export const DEMO_HINTS_GAME = solo("Démo indices", HINT_QUESTIONS, [round("r_hints", "Indices", "hints", HINT_QUESTIONS, { scoring: [{ type: "base", points: 0 }] })]);

/** A whole evening (Format mode): several rounds, each with its own mechanic, rules and timer. */
export const DEMO_EVENING_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Soirée quiz — formats variés",
  scenes: [],
  questions: [...TEXT_QUESTIONS, ...ORDER_QUESTIONS, ...NUMBER_QUESTIONS, ...HINT_QUESTIONS, ...BOARD_QUESTIONS],
  format: {
    id: "f_evening",
    name: "Soirée quiz",
    participants: { max: 500 },
    tieBreak: "speed",
    rounds: [
      round("r_e_text", "Manche 1 — Réponse libre", "text-answer", TEXT_QUESTIONS.slice(0, 2), { reserve: ["q_txt_3"], timer: { durationMs: 30_000, autoLock: true } }),
      round("r_e_order", "Manche 2 — Remettre dans l'ordre", "order", ORDER_QUESTIONS),
      round("r_e_hints", "Manche 3 — Indices", "hints", HINT_QUESTIONS, { scoring: [{ type: "base", points: 0 }] }),
      round("r_e_number", "Départage — Estimation", "number-answer", NUMBER_QUESTIONS.slice(0, 1), { mechanicConfig: { mode: "closest" } }),
    ],
  },
};

export const CHAT_QUESTIONS: Question[] = [
  q("q_chat_1", "Le chat décide : quelle est la plus grande planète du système solaire ?", { kind: "single", correct: "b", options: [{ id: "a", label: "Saturne" }, { id: "b", label: "Jupiter" }, { id: "c", label: "Neptune" }] }),
  q("q_chat_2", "Votre dessert préféré ?", { kind: "poll", options: [{ id: "a", label: "Tarte aux pommes" }, { id: "b", label: "Mousse au chocolat" }, { id: "c", label: "Crème brûlée" }] }),
];

/** Twitch / YouTube chat votes by majority (crowd-vote), 5 s of stream delay. */
export const DEMO_CHAT_GAME = solo("Démo vote du chat", CHAT_QUESTIONS, [round("r_chat", "Le chat vote", "crowd-vote", CHAT_QUESTIONS, { mechanicConfig: { streamDelayMs: 5000 }, scoring: [{ type: "base", points: 0 }], timer: { durationMs: 30_000, autoLock: true } })]);
