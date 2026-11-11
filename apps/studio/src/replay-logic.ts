import { createGame, replay, type Game, type Registry, type Snapshot } from "@quiz/engine";
import type { Event, Session } from "@quiz/schema";

/**
 * Replay from the journal (doc 09): state of the show after the first k events, as it was at that moment
 * (later undos are not applied yet). Journals can hold thousands of events, so states are checkpointed every
 * `every` events and each step replays only from the nearest checkpoint — the engine's own snapshot path,
 * which falls back to a full fold when an undo crosses the checkpoint (game.ts `isUsableSnapshot`).
 */
export type ReplayCursor = { readonly length: number; at(k: number): Game };

export function createReplayCursor(session: Session, events: readonly Event[], registry: Registry, every = 200): ReplayCursor {
  const checkpoints = new Map<number, Snapshot>();
  let last: Snapshot | null = null;
  const nearest = (k: number): Snapshot | null => {
    let best: Snapshot | null = last !== null && last.seq <= k ? last : null;
    for (const s of checkpoints.values()) if (s.seq <= k && (best === null || s.seq > best.seq)) best = s;
    return best;
  };
  const run = (k: number, from: Snapshot | null): Game => replay(session, events.slice(0, k), registry, from === null || from.seq === 0 ? undefined : from);
  return {
    length: events.length,
    at(kRaw) {
      const k = Math.max(0, Math.min(events.length, Math.floor(kRaw)));
      if (k === 0) return createGame(session);
      let from = nearest(k);
      // Lay checkpoints on the way, so a later jump nearby is short.
      for (let t = (Math.floor((from?.seq ?? 0) / every) + 1) * every; t < k; t += every) {
        const g = run(t, from);
        from = { seq: t, state: g.state };
        checkpoints.set(t, from);
      }
      const g = run(k, from);
      last = { seq: k, state: g.state };
      if (k % every === 0) checkpoints.set(k, last);
      return g;
    },
  };
}

export const ACTOR_LABEL: Readonly<Record<string, string>> = {
  control: "régie",
  "control-readonly": "régie (lecture)",
  host: "animateur",
  output: "sortie",
  player: "joueur",
  seat: "pupitre",
  studio: "studio",
  system: "système",
};

export function actorLabel(e: Pick<Event, "actor">): string {
  const role = ACTOR_LABEL[e.actor.role] ?? e.actor.role;
  return e.actor.id === undefined ? role : `${role} ${e.actor.id}`;
}

/** Wall-clock time of an event, HH:MM:SS. */
export function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
