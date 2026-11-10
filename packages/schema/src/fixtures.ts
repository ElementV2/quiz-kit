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
