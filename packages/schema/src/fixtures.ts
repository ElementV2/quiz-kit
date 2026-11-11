import type { GameDocument } from "./session.ts";

/**
 * Demo game used by tests, bots, chaos / load scripts and the dev server.
 * Shape is validated in fixtures.test.ts.
 */
export const DEMO_GAME: GameDocument = {
  schemaVersion: 1,
  title: "Démo culture G",
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
