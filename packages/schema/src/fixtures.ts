import { toMixedRounds } from "./upgrade.ts";
import type { GameDocument } from "./session.ts";
import { DEMO_ALLOCATION_GAME, DEMO_BOARD_GAME, DEMO_CHAT_GAME, DEMO_EVENING_GAME, DEMO_HINTS_GAME, DEMO_NUMBER_GAME, DEMO_ORDER_GAME, DEMO_PAIRS_GAME, DEMO_TEXT_GAME } from "./fixtures-formats.ts";

/**
 * Demo game used by tests, bots, chaos / load scripts and the dev server.
 * Shape is validated in fixtures.test.ts.
 */
export const DEMO_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Démo culture G",
  scenes: [],
  questions: [
    {
      id: "q_capital_fr",
      prompt: { text: "Quelle est la capitale de la France ?" },
      answerSpec: {
        kind: "single",
        correct: "b",
        options: [
          { id: "a", label: "Lyon" },
          { id: "b", label: "Paris" },
          { id: "c", label: "Marseille" },
          { id: "d", label: "Lille" },
        ],
      },
      hints: [],
      tags: ["géo"],
      notes: "Paris depuis 987 (Hugues Capet), selon la convention habituelle.",
    },
    {
      id: "q_earth_flat",
      prompt: { text: "La Terre est plate." },
      answerSpec: { kind: "boolean", correct: false },
      hints: [],
      tags: ["sciences"],
    },
    {
      id: "q_primes",
      prompt: { text: "Lesquels sont des nombres premiers ?" },
      answerSpec: {
        kind: "multi",
        correct: ["a", "c"],
        options: [
          { id: "a", label: "2" },
          { id: "b", label: "9" },
          { id: "c", label: "13" },
          { id: "d", label: "21" },
        ],
      },
      hints: [],
      tags: ["maths"],
    },
  ],
  format: {
    id: "f_demo",
    name: "QCM simple",
    participants: { mode: "solo", min: 1, max: 1000 },
    tieBreak: "control",
    rounds: [
      {
        id: "r_1",
        title: "Manche 1",
        mechanic: "choice",
        mechanicConfig: {},
        questions: ["q_capital_fr", "q_earth_flat", "q_primes"],
        reserve: [],
        timer: { durationMs: 20_000, autoLock: true },
        scoring: [
          { type: "base", points: 100 },
          { type: "timeDecay", minPoints: 50 },
        ],
      },
    ],
  },
};

/**
 * "Sondage à slots" template (poll-board, "Une famille en or"): two teams, `value` = % of respondents.
 * The round's ScoringRule is not used by poll-board (points = revealed values × multiplier).
 */
export const DEMO_POLL_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Démo sondage à slots",
  scenes: [],
  questions: [
    {
      id: "q_poll_breakfast",
      prompt: { text: "Citez un fruit que l'on mange au petit-déjeuner." },
      answerSpec: {
        kind: "poll",
        options: [
          { id: "a", label: "Banane", value: 38 },
          { id: "b", label: "Pomme", value: 22 },
          { id: "c", label: "Orange", value: 17 },
          { id: "d", label: "Kiwi", value: 9 },
          { id: "e", label: "Pamplemousse", value: 6 },
        ],
      },
      hints: [],
      tags: ["sondage"],
      notes: "Sondage réalisé auprès de 100 personnes (réponses fictives).",
    },
    {
      id: "q_poll_beach",
      prompt: { text: "Citez un objet que l'on emporte à la plage." },
      answerSpec: {
        kind: "poll",
        options: [
          { id: "a", label: "Serviette", value: 34, synonyms: ["drap de bain"] },
          { id: "b", label: "Crème solaire", value: 27 },
          { id: "c", label: "Parasol", value: 15 },
          { id: "d", label: "Lunettes de soleil", value: 11 },
          { id: "e", label: "Ballon", value: 5 },
        ],
      },
      hints: [],
      tags: ["sondage"],
      notes: "Accepter « maillot » ? Non : absent du sondage.",
    },
  ],
  format: {
    id: "f_demo_poll",
    name: "Sondage à slots",
    participants: { mode: "teams", min: 2, max: 20, teamSize: 5 },
    tieBreak: "control",
    rounds: [
      {
        id: "r_poll",
        title: "Sondage",
        mechanic: "poll-board",
        mechanicConfig: { maxStrikes: 3, multiplier: 1 },
        questions: ["q_poll_breakfast", "q_poll_beach"],
        reserve: [],
        scoring: [{ type: "base", points: 0 }],
      },
    ],
  },
};

/**
 * "Buzzer culture G" template: oral questions (expected answer for the host) and spoken multiple choice.
 * Right answer +100, wrong answer -50; a wrong player is locked out for the question.
 */
export const DEMO_BUZZER_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Démo buzzer culture G",
  scenes: [],
  questions: [
    {
      id: "q_buzz_everest",
      prompt: { text: "Quel est le plus haut sommet du monde ?" },
      answerSpec: { kind: "oral", expected: "L'Everest (8 849 m)" },
      hints: [],
      tags: ["géo"],
      notes: "Accepter « Chomolungma » ou « Sagarmatha ».",
    },
    {
      id: "q_buzz_planets",
      prompt: { text: "Quelle planète est surnommée la planète rouge ?" },
      answerSpec: {
        kind: "single",
        correct: "c",
        options: [
          { id: "a", label: "Vénus" },
          { id: "b", label: "Jupiter" },
          { id: "c", label: "Mars" },
          { id: "d", label: "Mercure" },
        ],
      },
      hints: [],
      tags: ["sciences"],
      notes: "Couleur due à l'oxyde de fer en surface.",
    },
    {
      id: "q_buzz_author",
      prompt: { text: "Qui a écrit « Les Misérables » ?" },
      answerSpec: { kind: "oral", expected: "Victor Hugo" },
      hints: [],
      tags: ["littérature"],
      notes: "Publié en 1862.",
    },
  ],
  format: {
    id: "f_demo_buzzer",
    name: "Buzzer culture G",
    participants: { mode: "solo", min: 2, max: 20 },
    tieBreak: "speed",
    rounds: [
      {
        id: "r_buzz",
        title: "Buzzer",
        mechanic: "buzzer",
        mechanicConfig: { lockoutOnWrong: true },
        questions: ["q_buzz_everest", "q_buzz_planets", "q_buzz_author"],
        reserve: [],
        scoring: [
          { type: "base", points: 100 },
          { type: "penalty", points: -50 },
        ],
      },
    ],
  },
};

/**
 * "QCM à paliers" template (ladder, QVGDM-like): one candidate, increasing steps, safe step at index 2,
 * 50:50 and audience jokers once per game. The round's ScoringRule is not used by ladder (the final gain
 * is written to the ledger when the ladder ends).
 */
export const DEMO_LADDER_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Démo QCM à paliers",
  scenes: [],
  questions: [
    {
      id: "q_lad_1",
      prompt: { text: "Combien de pattes a une araignée ?" },
      answerSpec: {
        kind: "single",
        correct: "b",
        options: [
          { id: "a", label: "6" },
          { id: "b", label: "8" },
          { id: "c", label: "10" },
          { id: "d", label: "12" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "Les insectes en ont 6.",
    },
    {
      id: "q_lad_2",
      prompt: { text: "Quel océan borde la côte ouest de la France ?" },
      answerSpec: {
        kind: "single",
        correct: "d",
        options: [
          { id: "a", label: "Pacifique" },
          { id: "b", label: "Indien" },
          { id: "c", label: "Arctique" },
          { id: "d", label: "Atlantique" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "Golfe de Gascogne ; la Manche au nord.",
    },
    {
      id: "q_lad_3",
      prompt: { text: "Qui a peint « La Joconde » ?" },
      answerSpec: {
        kind: "single",
        correct: "a",
        options: [
          { id: "a", label: "Léonard de Vinci" },
          { id: "b", label: "Michel-Ange" },
          { id: "c", label: "Raphaël" },
          { id: "d", label: "Botticelli" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "Conservée au Louvre depuis 1797.",
    },
    {
      id: "q_lad_4",
      prompt: { text: "En quelle année l'homme a-t-il marché sur la Lune pour la première fois ?" },
      answerSpec: {
        kind: "single",
        correct: "c",
        options: [
          { id: "a", label: "1965" },
          { id: "b", label: "1967" },
          { id: "c", label: "1969" },
          { id: "d", label: "1972" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "Apollo 11, juillet 1969.",
    },
    {
      id: "q_lad_5",
      prompt: { text: "Quel élément chimique a pour symbole « W » ?" },
      answerSpec: {
        kind: "single",
        correct: "a",
        options: [
          { id: "a", label: "Tungstène" },
          { id: "b", label: "Vanadium" },
          { id: "c", label: "Xénon" },
          { id: "d", label: "Zinc" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "W pour wolfram, autre nom du tungstène.",
    },
    {
      id: "q_lad_6",
      prompt: { text: "Quelle est la capitale de l'Australie ?" },
      answerSpec: {
        kind: "single",
        correct: "c",
        options: [
          { id: "a", label: "Sydney" },
          { id: "b", label: "Melbourne" },
          { id: "c", label: "Canberra" },
          { id: "d", label: "Perth" },
        ],
      },
      hints: [],
      tags: ["paliers"],
      notes: "Capitale fédérale depuis 1913.",
    },
  ],
  format: {
    id: "f_demo_ladder",
    name: "QCM à paliers",
    participants: { mode: "solo", min: 1, max: 1 },
    tieBreak: "control",
    rounds: [
      {
        id: "r_ladder",
        title: "Paliers",
        mechanic: "ladder",
        mechanicConfig: { steps: [200, 500, 1000, 5000, 20000, 100000], safeSteps: [2], jokers: ["fifty", "audience"] },
        questions: ["q_lad_1", "q_lad_2", "q_lad_3", "q_lad_4", "q_lad_5", "q_lad_6"],
        reserve: [],
        scoring: [{ type: "base", points: 0 }],
      },
    ],
  },
};

/** Built-in templates (roadmap phase 1): mechanics only, original look — never a broadcast show's branding. */

/** Every answer kind in one « Mixte » round (solo): QCM, true / false, several answers, spoken, free text, number, order, pairs, allocation. */
const MIXED_SHOWCASE: GameDocument = (() => {
  const extra = [...DEMO_BUZZER_GAME.questions.slice(0, 1), ...DEMO_TEXT_GAME.questions.slice(0, 1), ...DEMO_NUMBER_GAME.questions.slice(0, 1), ...DEMO_ORDER_GAME.questions.slice(0, 1), ...DEMO_PAIRS_GAME.questions, ...DEMO_ALLOCATION_GAME.questions];
  const round = DEMO_GAME.format.rounds[0];
  if (round === undefined) throw new Error("DEMO_GAME has a round");
  return {
    ...DEMO_GAME,
    title: "Modèle — Quiz mixte (tous les types)",
    questions: [...DEMO_GAME.questions, ...extra],
    format: { ...DEMO_GAME.format, id: "f_demo_mixed", name: "Quiz mixte", rounds: [{ ...round, title: "Manche mixte", mechanic: "mixed", mechanicConfig: {}, questions: [...round.questions, ...extra.map((q) => q.id)] }] },
  };
})();

export const TEMPLATES: readonly { readonly id: string; readonly game: GameDocument }[] = [
  { id: "g_modele_mixte", game: MIXED_SHOWCASE },
  { id: "g_modele_sondage", game: toMixedRounds({ ...DEMO_POLL_GAME, title: "Modèle — Une famille en or (sondages, équipes)" }) },
  { id: "g_modele_paliers", game: { ...DEMO_LADDER_GAME, title: "Modèle — QCM à paliers" } },
  { id: "g_modele_buzzer", game: { ...DEMO_BUZZER_GAME, title: "Modèle — Buzzer culture G" } },
  { id: "g_modele_plateau", game: { ...DEMO_BOARD_GAME, title: "Modèle — Plateau catégories × valeurs" } },
  { id: "g_modele_indices", game: { ...DEMO_HINTS_GAME, title: "Modèle — Indices dégressifs" } },
  { id: "g_modele_chat", game: { ...DEMO_CHAT_GAME, title: "Modèle — Vote du chat (Twitch / YouTube)" } },
  { id: "g_modele_soiree", game: toMixedRounds({ ...DEMO_EVENING_GAME, title: "Modèle — Soirée multi-manches" }) },
];

/**
 * Templates of older versions, as they were seeded: a library copy still identical to one of them (never edited) is
 * removed at start, or replaced by the template of the same id. Edited copies are the user's: always kept.
 */
export const RETIRED_TEMPLATES: readonly { readonly id: string; readonly game: GameDocument }[] = [
  { id: "g_modele_qcm", game: { ...DEMO_GAME, title: "Modèle — QCM rapide (Kahoot-like)" } },
  { id: "g_modele_texte", game: { ...DEMO_TEXT_GAME, title: "Modèle — Réponse libre" } },
  { id: "g_modele_estimation", game: { ...DEMO_NUMBER_GAME, title: "Modèle — Estimation (le plus proche)" } },
  { id: "g_modele_ordre", game: { ...DEMO_ORDER_GAME, title: "Modèle — Remettre dans l'ordre" } },
  { id: "g_modele_paires", game: { ...DEMO_PAIRS_GAME, title: "Modèle — Associations" } },
  { id: "g_modele_repartition", game: { ...DEMO_ALLOCATION_GAME, title: "Modèle — Répartition de mise" } },
  { id: "g_modele_sondage", game: { ...DEMO_POLL_GAME, title: "Modèle — Sondage à slots" } },
];
