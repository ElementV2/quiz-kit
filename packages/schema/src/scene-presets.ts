import { Scene, Theme } from "./scenes.ts";

/**
 * Built-in theme and output scenes for phase 1 (original design, no broadcast branding).
 * Safe areas EBU R 95 in 1920×1080: graphics safe x 96→1823, y 54→1025 — every zone below stays inside.
 */
export const DEFAULT_THEME: Theme = Theme.parse({
  id: "plateau",
  name: "Plateau",
  // Ink panels, gold signal, square cuts: reads well over any camera feed, nothing borrowed from a TV show.
  colors: {
    surface: "#111216",
    surfaceAlt: "#1d1f25",
    text: "#f6f3ec",
    muted: "#a7a296",
    primary: "#e9b13b",
    accent: "#ffd27a",
    correct: "#35b866",
    wrong: "#e5402f",
    selected: "#3fb6c6",
  },
  // Bundled by the output app (zero internet during a show).
  font: { family: "'Archivo Variable', 'Segoe UI', sans-serif", weight: 700 },
  radius: 4,
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
        { id: "media", type: "question-media", rect: { x: 560, y: 130, w: 800, h: 290 }, props: { sound: true } },
        { id: "question", type: "question", rect: { x: 96, y: 560, w: 1728, h: 180 } },
        { id: "answers", type: "answer-list", rect: { x: 96, y: 760, w: 1728, h: 260 }, props: { columns: 2, gap: 20 } },
        { id: "poll", type: "poll-board", rect: { x: 96, y: 760, w: 1728, h: 260 } },
        { id: "buzzer", type: "buzzer", rect: { x: 96, y: 440, w: 720, h: 100 } },
        // Ladder (paliers) and « La chaîne »: up to ~10 steps readable from the back of a room (≈ 40 px rows at 1080p).
        { id: "ladder", type: "ladder", rect: { x: 1424, y: 60, w: 400, h: 480 } },
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
      // Manual layer (doc 06 « TAKE / OUT ») : the control room puts the round title on air when it wants.
      id: "banner",
      name: "Bandeau titre",
      z: 40,
      mode: "manual",
      zones: [{ id: "banner", type: "text", rect: { x: 96, y: 900, w: 1000, h: 110 }, bind: "round.title", props: { size: 54 }, style: { background: "var(--q-color-primary)", "border-radius": "var(--q-radius)", padding: "0 32px" } }],
    },
    {
      id: "board",
      name: "Classement",
      z: 30,
      phases: ["idle", "round.end", "game.end"],
      zones: [{ id: "board", type: "leaderboard", rect: { x: 480, y: 140, w: 960, h: 860 }, props: { maxRows: 10, yieldToBoardGrid: true } }],
    },
    {
      // Board rounds (Jeopardy-like): the grid between two cells, while control picks the next one.
      id: "grid",
      name: "Plateau (grille)",
      z: 35,
      phases: ["idle"],
      zones: [{ id: "grid", type: "board-grid", rect: { x: 96, y: 130, w: 1728, h: 880 } }],
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
