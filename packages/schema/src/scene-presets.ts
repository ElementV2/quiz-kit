import { Scene, Theme } from "./scenes.ts";

/**
 * Built-in theme and output scenes for phase 1 (original design, no broadcast branding).
 * Safe areas EBU R 95 in 1920×1080: graphics safe x 96→1823, y 54→1025 — every zone below stays inside.
 */
export const DEFAULT_THEME: Theme = Theme.parse({
  id: "nuit",
  name: "Nuit électrique",
  colors: {
    surface: "#141833",
    surfaceAlt: "#1f2550",
    text: "#f4f5ff",
    muted: "#a3a8d6",
    primary: "#7c5cff",
    accent: "#ffcc4d",
    correct: "#22c55e",
    wrong: "#ef4444",
    selected: "#38bdf8",
  },
  font: { family: "Inter, 'Segoe UI', system-ui, sans-serif", weight: 700 },
  radius: 18,
  motion: "snappy",
});

const QUESTION_PHASES = ["presenting", "open", "locked", "judging", "revealed"] as const;

export const PROGRAM_SCENE: Scene = Scene.parse({
  id: "program",
  name: "Programme",
  layers: [
    {
      id: "set",
      name: "Plateau",
      z: 10,
      phases: [...QUESTION_PHASES],
      zones: [
        { id: "round", type: "round-info", rect: { x: 96, y: 60, w: 900, h: 56 } },
        { id: "question", type: "question", rect: { x: 96, y: 560, w: 1728, h: 180 } },
        { id: "answers", type: "answer-list", rect: { x: 96, y: 760, w: 1728, h: 260 }, props: { columns: 2, gap: 20 } },
      ],
    },
    {
      id: "timer",
      name: "Chrono",
      z: 50,
      phases: ["open"],
      zones: [{ id: "timer", type: "timer", rect: { x: 1644, y: 380, w: 180, h: 160 } }],
    },
    {
      id: "count",
      name: "Réponses reçues",
      z: 40,
      phases: ["open", "locked"],
      zones: [{ id: "count", type: "answer-count", rect: { x: 96, y: 440, w: 420, h: 100 } }],
    },
    {
      id: "board",
      name: "Classement",
      z: 30,
      phases: ["idle", "round.end", "game.end"],
      zones: [{ id: "board", type: "leaderboard", rect: { x: 480, y: 140, w: 960, h: 860 }, props: { maxRows: 10 } }],
    },
  ],
});

export const LEADERBOARD_SCENE: Scene = Scene.parse({
  id: "leaderboard",
  name: "Classement seul",
  layers: [{ id: "board", name: "Classement", z: 30, zones: [{ id: "board", type: "leaderboard", rect: { x: 480, y: 120, w: 960, h: 880 }, props: { maxRows: 12 } }] }],
});

export const WALL_SCENE: Scene = Scene.parse({
  id: "wall",
  name: "Mur LED",
  layers: [
    { id: "question", name: "Question", z: 10, phases: [...QUESTION_PHASES], zones: [{ id: "question", type: "question", rect: { x: 96, y: 300, w: 1728, h: 480 }, props: { size: 96 } }] },
    { id: "board", name: "Classement", z: 30, phases: ["idle", "round.end", "game.end"], zones: [{ id: "board", type: "leaderboard", rect: { x: 480, y: 120, w: 960, h: 880 } }] },
  ],
});

export const OUTPUT_SCENES: Readonly<Record<string, Scene>> = { program: PROGRAM_SCENE, leaderboard: LEADERBOARD_SCENE, wall: WALL_SCENE };
