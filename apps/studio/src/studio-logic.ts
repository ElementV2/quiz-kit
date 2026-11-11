import { createGame, decide, defaultRegistry, project, type Game } from "@quiz/engine";
import type { Action, Actor, GameDocument, Phase, Scene, View, Zone } from "@quiz/schema";

/**
 * Studio logic, pure and tested (doc 07). The studio is the only front allowed to run the engine (ADR-0007):
 * « simuler l'état » plays the real rules locally on fake players to preview a scene in any phase.
 */

export const SIMULATED_PHASES = ["idle", "presenting", "open", "locked", "revealed", "game.end"] as const satisfies readonly Phase[];
export type SimulatedPhase = (typeof SIMULATED_PHASES)[number];

const CTL: Actor = { role: "control", id: "studio" };

/** Drives a local game to `phase` on question `questionIndex` with 3 fake players, returns the output view. */
export function simulateView(game: GameDocument, phase: SimulatedPhase, questionIndex = 0): View | null {
  let g: Game = createGame({ schemaVersion: 1, id: "ses_studio", game, seed: 1, createdAt: 0 });
  let at = 1_000_000;
  const step = (action: Action, actor: Actor = CTL): boolean => {
    at += 1000;
    const r = decide(g, { action, actor, idempotencyKey: null }, at, defaultRegistry);
    if (r.ok) g = r.value.game;
    return r.ok;
  };
  const names = ["Camille", "Sacha", "Noa"];
  names.forEach((n, i) => step({ type: "player.add", participantId: `p_sim${i}`, displayName: n, seat: i + 1, channel: "seat" }));
  step({ type: "game.start" });
  step({ type: "round.start" });
  // Score a little so the leaderboard is not empty.
  names.forEach((_, i) => step({ type: "score.adjust", target: { participantId: `p_sim${i}` }, delta: (3 - i) * 100, reason: "bonus" }));
  if (phase === "game.end") {
    const round = game.format.rounds[0];
    for (let i = 0; i < (round?.questions.length ?? 0); i++) {
      step({ type: "question.present", questionIndex: i });
      step({ type: "question.next" });
    }
    return project(g, { role: "output", scene: "studio" }, defaultRegistry);
  }
  if (phase === "idle") return project(g, { role: "output", scene: "studio" }, defaultRegistry);
  if (!step({ type: "question.present", questionIndex })) return project(g, { role: "output", scene: "studio" }, defaultRegistry);
  if (phase !== "presenting") {
    step({ type: "question.open" });
    // Fake answers: first option for two players, second for one.
    const view = project(g, { role: "control" }, defaultRegistry);
    const opts = view.mechanic?.mechanic === "choice" ? view.mechanic.options : [];
    names.forEach((_, i) => {
      const o = opts[i === 2 ? 1 : 0];
      if (o !== undefined) step({ type: "answer.submit", participantId: `p_sim${i}`, answer: { kind: "choice", optionIds: [o.id] } });
    });
    if (phase === "locked" || phase === "revealed") step({ type: "question.lock" });
    if (phase === "revealed") step({ type: "question.reveal" });
  }
  return project(g, { role: "output", scene: "studio" }, defaultRegistry);
}

export const GRID = 8;
export const snap = (v: number, grid = GRID): number => Math.round(v / grid) * grid;

/** EBU R 95 safe areas for 1920×1080 (OPEN-QUESTIONS, vérifié) : action 3.5 %, graphics 5 %. */
export const SAFE_AREAS = {
  action: { x: 67, y: 38, w: 1786, h: 1004 },
  graphics: { x: 96, y: 54, w: 1728, h: 972 },
} as const;

/** Keeps a rectangle inside the scene and on the grid. */
export function clampRect(r: Zone["rect"], size: { w: number; h: number }): Zone["rect"] {
  const w = Math.max(GRID * 2, Math.min(snap(r.w), size.w));
  const h = Math.max(GRID * 2, Math.min(snap(r.h), size.h));
  return { x: Math.max(0, Math.min(snap(r.x), size.w - w)), y: Math.max(0, Math.min(snap(r.y), size.h - h)), w, h };
}

/** Zones outside the graphics safe area (warning in the inspector). */
export function outsideSafe(z: Zone): boolean {
  const s = SAFE_AREAS.graphics;
  return z.rect.x < s.x || z.rect.y < s.y || z.rect.x + z.rect.w > s.x + s.w || z.rect.y + z.rect.h > s.y + s.h;
}

/** Longest text a zone will have to show in this game (doc 07 « texte le plus long posé », auto-fit warning). */
export function longestText(game: GameDocument, z: Zone): string {
  switch (z.type) {
    case "question":
      return game.questions.reduce((a, q) => (q.prompt.text.length > a.length ? q.prompt.text : a), "");
    case "answer-list":
      return game.questions.flatMap((q) => ("options" in q.answerSpec ? q.answerSpec.options.map((o) => o.label) : [])).reduce((a, l) => (l.length > a.length ? l : a), "");
    case "answer-count":
    case "board-grid":
    case "buzzer":
    case "ladder":
    case "poll-board":
    case "image":
    case "leaderboard":
    case "question-media":
    case "round-info":
    case "text":
    case "timer":
      return "";
    default:
      return "";
  }
}

const STATES_BY_TYPE: Partial<Record<Zone["type"], readonly string[]>> = {
  "answer-list": ["idle", "selected", "correct", "wrong"],
  question: ["idle"],
  timer: ["idle"],
  leaderboard: ["idle"],
};

/** Assets the designer must deliver (doc 07 B) : one file per state, 1x and 2x — a repeated zone is ONE file per state. */
export function assetSheet(scene: Scene): { file: string; zone: string; state: string; x: number; y: number; w: number; h: number; w2: number; h2: number }[] {
  return scene.layers.flatMap((l) =>
    l.zones.flatMap((z) => {
      const cell = z.type === "answer-list" ? answerCell(z) : { w: z.rect.w, h: z.rect.h };
      return (STATES_BY_TYPE[z.type] ?? ["idle"]).map((state) => ({ file: `${z.id}_${state}@2x.png`, zone: z.id, state, x: z.rect.x, y: z.rect.y, w: cell.w, h: cell.h, w2: cell.w * 2, h2: cell.h * 2 }));
    }),
  );
}

function answerCell(z: Zone): { w: number; h: number } {
  const cols = typeof z.props["columns"] === "number" ? z.props["columns"] : 2;
  const gap = typeof z.props["gap"] === "number" ? z.props["gap"] : 16;
  const rows = 2;
  return { w: Math.round((z.rect.w - gap * (cols - 1)) / cols), h: Math.round((z.rect.h - gap * (rows - 1)) / rows) };
}

export function assetSheetCsv(scene: Scene): string {
  const rows = assetSheet(scene).map((a) => [a.file, a.zone, a.state, a.x, a.y, `${a.w}x${a.h}`, `${a.w2}x${a.h2}`, "9-slice si cadre extensible"].join(";"));
  return ["fichier;zone;état;x;y;taille 1x;taille 2x;notes", ...rows].join("\n");
}

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Designer template (doc 07 B) : zones with names / coordinates / sizes, safe areas, longest text placed. */
export function templateSvg(scene: Scene, game: GameDocument): string {
  const { w, h } = scene.size;
  const zones = scene.layers.flatMap((l) => l.zones.map((z) => ({ z, layer: l.name })));
  const parts = zones.map(({ z, layer }) => {
    const t = longestText(game, z);
    return [
      `<g id="${esc(z.id)}" data-layer="${esc(layer)}">`,
      `<rect x="${z.rect.x}" y="${z.rect.y}" width="${z.rect.w}" height="${z.rect.h}" fill="rgba(124,92,255,.18)" stroke="#7c5cff" stroke-width="2"/>`,
      `<text x="${z.rect.x + 8}" y="${z.rect.y + 24}" font-size="20" fill="#fff" font-family="sans-serif">${esc(z.id)} · ${z.type} · ${z.rect.w}×${z.rect.h} @ ${z.rect.x},${z.rect.y}</text>`,
      t.length > 0 ? `<text x="${z.rect.x + 8}" y="${z.rect.y + z.rect.h - 12}" font-size="16" fill="#ffcc4d" font-family="sans-serif">texte le plus long : ${esc(t.slice(0, 120))}</text>` : "",
      `</g>`,
    ].join("");
  });
  const s = SAFE_AREAS;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#101225"/>`,
    `<rect x="${s.action.x}" y="${s.action.y}" width="${s.action.w}" height="${s.action.h}" fill="none" stroke="#ef4444" stroke-dasharray="12 8"/>`,
    `<rect x="${s.graphics.x}" y="${s.graphics.y}" width="${s.graphics.w}" height="${s.graphics.h}" fill="none" stroke="#22c55e" stroke-dasharray="12 8"/>`,
    ...parts,
    `<text x="${s.graphics.x}" y="${h - 14}" font-size="16" fill="#9aa0c7" font-family="sans-serif">${esc(scene.name)} — rouge : action safe 3,5 % · vert : graphics safe 5 % (EBU R 95)</text>`,
    `</svg>`,
  ].join("\n");
}

/** Re-import by naming convention `<zone>_<state>@2x.png` (doc 07 B) : what matches, what is missing, wrong sizes. */
export function matchDeliveredAssets(scene: Scene, files: readonly { name: string; w: number; h: number }[]): { matched: { file: string; zone: string; state: string }[]; missing: string[]; wrongSize: string[]; unknown: string[] } {
  const sheet = assetSheet(scene);
  const byName = new Map(sheet.map((a) => [a.file.toLowerCase(), a]));
  const matched: { file: string; zone: string; state: string }[] = [];
  const wrongSize: string[] = [];
  const unknown: string[] = [];
  for (const f of files) {
    const a = byName.get(f.name.toLowerCase());
    if (a === undefined) {
      unknown.push(f.name);
      continue;
    }
    if (Math.abs(f.w - a.w2) > 1 || Math.abs(f.h - a.h2) > 1) wrongSize.push(`${f.name} : ${f.w}×${f.h} au lieu de ${a.w2}×${a.h2}`);
    else matched.push({ file: f.name, zone: a.zone, state: a.state });
  }
  const delivered = new Set(files.map((f) => f.name.toLowerCase()));
  return { matched, missing: sheet.filter((a) => !delivered.has(a.file.toLowerCase())).map((a) => a.file), wrongSize, unknown };
}

/** Missing states derived from the idle look (doc 07 A « états manquants dérivés automatiquement »). */
export function deriveStates(z: Zone): Zone["states"] {
  const base = z.states["idle"] ?? {};
  return {
    idle: base,
    selected: { ...base, filter: "brightness(1.15) saturate(1.2)", ...z.states["selected"] },
    correct: { ...base, filter: "hue-rotate(80deg) saturate(1.3)", ...z.states["correct"] },
    wrong: { ...base, filter: "grayscale(.8) brightness(.7)", ...z.states["wrong"] },
    disabled: { ...base, filter: "grayscale(1) opacity(.5)", ...z.states["disabled"] },
  };
}
