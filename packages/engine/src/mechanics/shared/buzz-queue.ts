import { z } from "zod";
import { ParticipantId, type ActionOf } from "@quiz/schema";
import type { MechanicEnv } from "../../mechanic.ts";
import { err, ok, type Rejection, type Result } from "../../result.ts";

/**
 * Buzz queue shared by `buzzer` and `board`: each `buzz` joins the queue in journal order, the head has the
 * hand; `answer.judge` on the hand settles it (wrong → out of the queue, locked out if `lockoutOnWrong`;
 * right → buzzers close for the question).
 */

export const Buzz = z.strictObject({ participantId: ParticipantId, at: z.number().int(), status: z.enum(["waiting", "correct", "wrong"]) });
export type Buzz = z.infer<typeof Buzz>;

type Q = { readonly buzzes: readonly Buzz[]; readonly lockoutOnWrong: boolean };

export const winnerOf = (s: Q): string | null => s.buzzes.find((b) => b.status === "correct")?.participantId ?? null;
export const queueOf = (s: Q): string[] => s.buzzes.filter((b) => b.status === "waiting").map((b) => b.participantId);
export const handOf = (s: Q): string | null => (winnerOf(s) === null ? (queueOf(s)[0] ?? null) : null);
export const isLockedOut = (s: Q, pid: string): boolean => s.lockoutOnWrong && s.buzzes.some((b) => b.participantId === pid && b.status === "wrong");
export const lockedOutOf = (s: Q): string[] => (s.lockoutOnWrong ? [...new Set(s.buzzes.filter((b) => b.status === "wrong").map((b) => b.participantId))] : []);

/** Phase `open` is checked by the core; the participant is known and active. */
export function onBuzz<S extends Q>(s: S, a: ActionOf<"buzz">, env: MechanicEnv): Result<S, Rejection> {
  if (winnerOf(s) !== null) return err("conflict", "question déjà gagnée");
  if (s.buzzes.some((b) => b.participantId === a.participantId && b.status === "waiting")) return err("conflict", "déjà dans la file");
  if (isLockedOut(s, a.participantId)) return err("forbidden", "joueur bloqué pour cette question");
  return ok({ ...s, buzzes: [...s.buzzes, { participantId: a.participantId, at: env.at, status: "waiting" }] });
}

export function onJudge<S extends Q>(s: S, a: ActionOf<"answer.judge">, env: MechanicEnv): Result<S, Rejection> {
  if (env.phase !== "open" && env.phase !== "locked" && env.phase !== "judging") return err("wrong-phase", "aucune réponse à juger");
  if (a.participantId === undefined) return err("invalid", "préciser le joueur jugé (participantId)");
  const hand = handOf(s);
  if (hand === null) return err("conflict", "personne n'a la main");
  if (hand !== a.participantId) return err("conflict", "ce joueur n'a pas la main");
  const status = a.correct ? "correct" : "wrong";
  // The hand is the first waiting buzz: update exactly that one.
  const i = s.buzzes.findIndex((b) => b.status === "waiting");
  return ok({ ...s, buzzes: s.buzzes.map((b, j) => (j === i ? { ...b, status } : b)) });
}

/** The viewing player's own buzzer state (null for other audiences). */
export function buzzMe(s: Q, audience: string, participantId: string | null, phase: string) {
  if (audience !== "player" || participantId === null) return null;
  const queue = queueOf(s);
  const pos = queue.indexOf(participantId);
  const lockedOut = isLockedOut(s, participantId);
  return { hasHand: handOf(s) === participantId, queuePosition: pos < 0 ? null : pos + 1, lockedOut, canBuzz: phase === "open" && winnerOf(s) === null && pos < 0 && !lockedOut };
}
