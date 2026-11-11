import { nextStep } from "@quiz/protocol";
import type { Action, ControlView } from "@quiz/schema";
import type { SessionRuntime } from "../runtime/session-runtime.ts";

/**
 * External control (doc 08 « API de contrôle externe »): the same named commands over HTTP (Bitfocus Companion
 * "Generic: HTTP Requests", Stream Deck, scripts) and OSC (Companion "Generic: OSC", lighting desks, buzzer
 * boxes). A command is turned into ONE engine action, journaled like any control-room click (actor
 * `control` / `api` or `osc`), so it is undoable and replayed identically.
 */

export const COMMANDS = ["next", "open", "lock", "reveal", "undo", "timer-add", "timer-stop", "layer-take", "layer-out", "layer-toggle", "buzz", "judge", "hint", "joker", "stop"] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (x: string): x is Command => (COMMANDS as readonly string[]).includes(x);

export type CommandResult = { readonly ok: true; readonly did: string; readonly seq: number } | { readonly ok: false; readonly code: string; readonly reason: string };

type Arg = string | number | boolean | null | bigint | undefined;

const num = (a: Arg): number | null => {
  const n = typeof a === "number" ? a : typeof a === "bigint" ? Number(a) : typeof a === "string" ? Number(a) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (a: Arg): string | null => (typeof a === "string" && a.length > 0 ? a : typeof a === "number" ? String(a) : null);
const truthy = (a: Arg): boolean | null => {
  if (typeof a === "boolean") return a;
  if (typeof a === "number") return a !== 0;
  if (a === "1" || a === "true" || a === "oui" || a === "bon") return true;
  if (a === "0" || a === "false" || a === "non" || a === "faux") return false;
  return null;
};
const LAYER_ID = /^[0-9a-z-]{1,64}$/;

type Plan = { readonly action: Action; readonly label: string } | { readonly error: string };

/** Pure: command + args + current control view → the action to submit (or why not). */
export function planCommand(cmd: Command, args: readonly Arg[], v: ControlView, now: number): Plan {
  switch (cmd) {
    case "next": {
      const n = nextStep(v);
      // A greyed step (chain: judge first, vote not closable yet): its label says what to do first.
      if (n === null) return { error: "partie terminée" };
      return n.action === null ? { error: n.label } : { action: n.action, label: n.label };
    }
    case "open":
      return { action: { type: "question.open" }, label: "Ouvrir les réponses" };
    case "lock":
      return { action: { type: "question.lock" }, label: "Fermer les réponses" };
    case "reveal":
      return { action: { type: "question.reveal" }, label: "Révéler" };
    case "undo":
      return { action: { type: "undo" }, label: "Annuler" };
    case "timer-add": {
      if (v.timer === null) return { error: "aucun chrono en cours" };
      const s = num(args[0]) ?? 10;
      const remaining = Math.max(0, v.timer.endsAt - now) + Math.round(s * 1000);
      return { action: { type: "timer.set", remainingMs: Math.min(3_600_000, Math.max(0, remaining)) }, label: `Chrono ${s >= 0 ? "+" : ""}${s} s` };
    }
    case "timer-stop":
      return { action: { type: "timer.stop" }, label: "Stop chrono" };
    case "layer-take":
    case "layer-out":
    case "layer-toggle": {
      const id = str(args[0]);
      if (id === null || !LAYER_ID.test(id)) return { error: "identifiant de couche attendu (ex. banner)" };
      const on = v.layers[id] === true;
      const take = cmd === "layer-take" || (cmd === "layer-toggle" && !on);
      return { action: { type: take ? "layer.take" : "layer.out", layerId: id }, label: `${take ? "TAKE" : "OUT"} ${id}` };
    }
    case "buzz": {
      const seat = num(args[0]);
      const p = seat === null ? undefined : v.participants.find((x) => x.seat === seat);
      if (p === undefined) return { error: `aucun joueur au siège ${String(args[0])}` };
      return { action: { type: "buzz", participantId: p.id }, label: `Buzz siège ${seat}` };
    }
    case "judge": {
      const correct = truthy(args[0]);
      const m = v.mechanic;
      const hand = m?.mechanic === "buzzer" || m?.mechanic === "board" ? m.hand : null;
      if (correct === null) return { error: "1 (bonne) ou 0 (mauvaise) attendu" };
      if (hand === null) return { error: "personne n'a la main" };
      return { action: { type: "answer.judge", participantId: hand, correct }, label: correct ? "Bonne réponse" : "Mauvaise réponse" };
    }
    case "hint": {
      const m = v.mechanic;
      if (m?.mechanic === "hints") return { action: { type: "element.reveal", index: m.hintCount }, label: "Indice suivant" };
      if (m?.mechanic === "reveal-image") return { action: { type: "element.reveal", index: m.revealed.length }, label: "Dévoiler une case" };
      return { error: "la question en cours n'a ni indices ni image à dévoiler" };
    }
    case "joker": {
      const j = str(args[0]);
      if (j !== "fifty" && j !== "audience") return { error: "joker fifty ou audience attendu" };
      return { action: { type: "joker.use", joker: j }, label: j === "fifty" ? "Joker 50:50" : "Joker public" };
    }
    case "stop":
      return { action: { type: "ladder.stop" }, label: "Le candidat s'arrête" };
    default:
      return { error: "commande inconnue" };
  }
}

/** Plans against the live state and queues the action (group commit, never blocks the loop). */
export function runCommand(rt: SessionRuntime, cmd: Command, args: readonly Arg[], via: "api" | "osc", now: number = Date.now(), key: string | null = null): Promise<CommandResult> {
  // Last broadcast control view, cached per seq: a burst of commands never triggers one projection each.
  const v = rt.welcomeView({ role: "control" });
  if (v.role !== "control") return Promise.resolve({ ok: false, code: "server-error", reason: "vue régie indisponible" });
  const plan = planCommand(cmd, args, v, now);
  if ("error" in plan) return Promise.resolve({ ok: false, code: "invalid", reason: plan.error });
  return new Promise((resolve) => {
    // `key`: the caller's idempotency key (HTTP `Idempotency-Key`): a retried request is applied once.
    rt.enqueue(plan.action, { role: "control", id: via }, key, (ack) => {
      resolve(ack.ok ? { ok: true, did: plan.label, seq: ack.eventSeq } : { ok: false, code: ack.code, reason: ack.reason });
    });
  });
}
