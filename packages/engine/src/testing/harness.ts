import { DEMO_GAME, type Action, type Actor, type GameDocument, type Role, type Session } from "@quiz/schema";
import { createGame, decide, type Game } from "../game.ts";
import type { Registry } from "../mechanic.ts";

/** Test-only helpers (not exported from the package). */

export function makeSession(game: GameDocument = DEMO_GAME, seed = 1): Session {
  return { schemaVersion: 1, id: "ses_test", game, seed, createdAt: 0 };
}

export const actor = (role: Role, id?: string): Actor => (id === undefined ? { role } : { role, id });
export const CONTROL = actor("control", "op");

export type Step = readonly [Actor, Action];

/** Applies steps one second apart; throws with context on the first rejection. */
export function run(registry: Registry, steps: readonly Step[], from: Game = createGame(makeSession()), startAt = 1_000_000): Game {
  let g = from;
  let at = startAt + g.events.length * 1000;
  for (const [who, action] of steps) {
    at += 1000;
    const r = decide(g, { action, actor: who, idempotencyKey: null }, at, registry);
    if (!r.ok) throw new Error(`step ${action.type} rejected: ${r.error.code} ${r.error.message}`);
    g = r.value.game;
  }
  return g;
}

export const ctl = (action: Action): Step => [CONTROL, action];

export function addPlayers(n: number): Step[] {
  return Array.from({ length: n }, (_, i) => ctl({ type: "player.add", participantId: `p_${i + 1}`, displayName: `Joueur ${i + 1}`, seat: i + 1, channel: "seat" }));
}

export const answer = (participantId: string, ...optionIds: string[]): Step => [
  actor("player", participantId),
  { type: "answer.submit", participantId, answer: { kind: "choice", optionIds } },
];

/** Deep-freezes a value so any mutation by the engine throws (ESM is strict mode). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
