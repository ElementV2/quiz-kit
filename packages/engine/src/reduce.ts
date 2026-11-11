import { isAllowed, type Action, type ActionOf, type Actor, type Participant, type ScoreEntry, type ScoreTarget } from "@quiz/schema";
import type { AnyMechanic, FixedJudgement, MechanicEnv, Registry } from "./mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "./result.ts";
import type { Rng } from "./rng.ts";
import { pointsFor } from "./scoring.ts";
import { currentQuestion, currentRound, participantTotal, teamTotal, type GameState } from "./state.ts";

/** Everything comes from the event (ADR-0010): no clock, no global randomness. */
export type Ctx = { readonly at: number; readonly seq: number; readonly actor: Actor; readonly rng: Rng };

type R = Result<GameState, Rejection>;

const QUESTION_PHASES = new Set(["presenting", "open", "locked", "judging", "revealed"]);

/**
 * Pure core reducer. `undo` is not handled here: it is resolved over the journal by `game.ts`.
 * Overrides (score.*, player.*, team.add) are accepted in every phase (doc 03).
 */
export function reduce(s: GameState, action: Action, ctx: Ctx, registry: Registry): R {
  if (!isAllowed(ctx.actor.role, action.type)) {
    return err("forbidden", `le rôle ${ctx.actor.role} ne peut pas faire ${action.type}`);
  }
  const r = reduceAllowed(s, action, ctx, registry);
  return r.ok ? ok({ ...r.value, lastSeq: ctx.seq }) : r;
}

function reduceAllowed(s: GameState, a: Action, ctx: Ctx, registry: Registry): R {
  switch (a.type) {
    case "game.start":
      if (s.phase !== "lobby") return err("wrong-phase", "la partie a déjà commencé");
      return ok({ ...s, phase: "idle" });

    case "round.start": {
      if (s.phase !== "idle" && s.phase !== "round.end") return err("wrong-phase", "une question est en cours");
      const current = currentRound(s);
      const remaining = current !== null && s.phase === "idle" && (s.questionIndex ?? -1) + 1 < current.questions.length;
      if (a.roundIndex === undefined && remaining) {
        return err("conflict", "il reste des questions dans la manche : préciser roundIndex pour sauter");
      }
      const index = a.roundIndex ?? (s.roundIndex === null ? 0 : s.roundIndex + 1);
      if (s.game.format.rounds[index] === undefined) return err("not-found", `manche ${index} inexistante`);
      return ok({ ...s, phase: "idle", roundIndex: index, questionIndex: null, carry: null, roundLedgerStart: s.ledger.length });
    }

    case "question.present":
      return present(s, a, ctx, registry);

    case "question.open": {
      if (s.phase !== "presenting") return err("wrong-phase", "présenter la question avant d'ouvrir les réponses");
      const timer = currentRound(s)?.timer;
      return ok({
        ...s,
        phase: "open",
        openedAt: ctx.at,
        lockedAt: null,
        windowMs: timer?.durationMs ?? null,
        timer: timer === undefined ? null : { id: ctx.seq, endsAt: ctx.at + timer.durationMs, durationMs: timer.durationMs, autoLock: timer.autoLock },
      });
    }

    case "question.lock":
      if (s.phase !== "open") return err("wrong-phase", "les réponses ne sont pas ouvertes");
      return ok({ ...s, phase: "locked", timer: null, lockedAt: ctx.at });

    case "timer.expired": {
      if (s.timer === null || s.timer.id !== a.timerId) return err("stale", "chrono déjà arrêté ou remplacé");
      if (s.phase !== "open") return ok({ ...s, timer: null });
      return ok(s.timer.autoLock ? { ...s, phase: "locked", timer: null, lockedAt: ctx.at } : { ...s, timer: null });
    }

    case "timer.set": {
      // Only meaningful while answers are open (doc 03); to re-open answers, undo the lock.
      if (s.phase !== "open") return err("wrong-phase", "le chrono ne se règle que réponses ouvertes");
      const endsAt = ctx.at + a.remainingMs;
      return ok({
        ...s,
        // The decay window follows the timer actually armed (an extension widens it).
        windowMs: s.openedAt === null ? null : endsAt - s.openedAt,
        timer: { id: ctx.seq, endsAt, durationMs: a.remainingMs, autoLock: s.timer?.autoLock ?? currentRound(s)?.timer?.autoLock ?? true },
      });
    }

    case "timer.stop":
      if (s.timer === null) return err("conflict", "aucun chrono en cours");
      return ok({ ...s, timer: null });

    case "question.reveal":
      return reveal(s, ctx, registry);

    case "question.next": {
      if (!QUESTION_PHASES.has(s.phase)) return err("wrong-phase", "aucune question en cours");
      const round = currentRound(s);
      const qi = s.questionIndex ?? 0;
      const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
      const endsRound = m !== null && s.mechanic !== null && m.endsRound(s.mechanic.state, s.phase);
      const isLastQuestion = round === null || qi + 1 >= round.questions.length || endsRound;
      const isLastRound = s.roundIndex === null || s.roundIndex + 1 >= s.game.format.rounds.length;
      const phase = !isLastQuestion ? "idle" : isLastRound ? "game.end" : "round.end";
      const carry = s.mechanic === null ? s.carry : { id: s.mechanic.id, state: s.mechanic.state, revealed: s.phase === "revealed", questionIndex: qi };
      // A round ending here lets the mechanic bank what was not scored by a reveal (ladder skipped / stopped).
      const question = currentQuestion(s);
      const closing = isLastQuestion && m !== null && s.mechanic !== null && question !== null ? m.closeRound(s.mechanic.state, s.phase) : [];
      const ledger = [...s.ledger, ...fixedEntries(s, ctx, closing, question?.id ?? null, 0)];
      return ok({ ...s, phase, ledger, mechanic: null, carry, timer: null, openedAt: null, lockedAt: null, windowMs: null });
    }

    case "answer.submit": {
      if (s.phase !== "open") return err("wrong-phase", "les réponses ne sont pas ouvertes");
      const who = checkPlayerIntent(s, a.participantId, ctx);
      if (!who.ok) return who;
      return withMechanic(s, registry, (m, state) => m.submit(state, a.participantId, a.answer, envOf(s, ctx)));
    }

    case "buzz": {
      if (s.phase !== "open") return err("wrong-phase", "les buzzers ne sont pas ouverts");
      const who = checkPlayerIntent(s, a.participantId, ctx);
      if (!who.ok) return who;
      return mechanicAction(s, a, ctx, registry);
    }

    case "answer.judge":
      if (a.participantId !== undefined && !s.participants.some((p) => p.id === a.participantId)) return err("not-found", "joueur inconnu");
      return mechanicAction(s, a, ctx, registry);

    case "poll.control":
    case "poll.steal":
      if (!s.teams.some((t) => t.id === a.teamId)) return err("not-found", "équipe inconnue");
      return mechanicAction(s, a, ctx, registry);

    case "element.reveal":
    case "joker.use":
    case "ladder.stop":
      return mechanicAction(s, a, ctx, registry);

    case "score.adjust":
      return addEntry(s, a.target, a.delta, a.reason, a.note ?? null, ctx);

    case "score.setTotal": {
      const current = "participantId" in a.target ? participantTotal(s, a.target.participantId) : teamTotal(s, a.target.teamId);
      if (current === a.total) return err("conflict", "le total est déjà à cette valeur");
      return addEntry(s, a.target, a.total - current, "manual", `total fixé à ${a.total}`, ctx);
    }

    case "score.void": {
      const e = s.ledger.find((x) => x.id === a.entryId);
      if (e === undefined) return err("not-found", "ligne de score inconnue");
      if (e.voided) return err("conflict", "ligne déjà annulée");
      return ok({ ...s, ledger: s.ledger.map((x) => (x.id === a.entryId ? { ...x, voided: true } : x)) });
    }

    case "player.add": {
      if (s.participants.some((p) => p.id === a.participantId)) return err("conflict", "identifiant de joueur déjà pris");
      if (s.participants.length >= s.game.format.participants.max) return err("conflict", "nombre maximum de joueurs atteint");
      if (a.seat !== undefined && s.participants.some((p) => p.seat === a.seat)) return err("conflict", `siège ${a.seat} déjà occupé`);
      if (a.teamId !== undefined && !s.teams.some((t) => t.id === a.teamId)) return err("not-found", "équipe inconnue");
      const p: Participant = {
        id: a.participantId,
        displayName: a.displayName,
        teamId: a.teamId ?? null,
        seat: a.seat ?? null,
        status: "active",
        channel: a.channel,
      };
      return ok({ ...s, participants: [...s.participants, p] });
    }

    case "player.rename":
      return updateParticipant(s, a.participantId, (p) => ok({ ...p, displayName: a.displayName }));

    case "player.setStatus":
      return updateParticipant(s, a.participantId, (p) => ok({ ...p, status: a.status }));

    case "player.setTeam":
      if (a.teamId !== null && !s.teams.some((t) => t.id === a.teamId)) return err("not-found", "équipe inconnue");
      return updateParticipant(s, a.participantId, (p) => ok({ ...p, teamId: a.teamId }));

    case "player.setSeat":
      if (a.seat !== null && s.participants.some((p) => p.seat === a.seat && p.id !== a.participantId)) {
        return err("conflict", `siège ${a.seat} déjà occupé`);
      }
      return updateParticipant(s, a.participantId, (p) => ok({ ...p, seat: a.seat }));

    case "player.remove":
    {
      if (!s.participants.some((p) => p.id === a.participantId)) return err("not-found", "joueur inconnu");
      const without = { ...s, participants: s.participants.filter((p) => p.id !== a.participantId) };
      // Purge their answer (and carried progression): an id reused later must not inherit it (no leak, no phantom score).
      const carryMechanic = s.carry === null ? null : registry.get(s.carry.id);
      // Unknown carried mechanic (cannot purge it): drop the carry rather than keep stale progression.
      const purged = s.carry === null ? without : carryMechanic === null ? { ...without, carry: null } : { ...without, carry: { ...s.carry, state: carryMechanic.removeParticipant(s.carry.state, a.participantId) } };
      if (s.mechanic === null) return ok(purged);
      return withMechanic(purged, registry, (m, state) => ok(m.removeParticipant(state, a.participantId)));
    }

    case "layer.take":
      if (s.layers[a.layerId] === true) return err("conflict", "couche déjà à l'antenne");
      return ok({ ...s, layers: { ...s.layers, [a.layerId]: true } });

    case "layer.out":
      if (s.layers[a.layerId] !== true) return err("conflict", "couche déjà retirée");
      return ok({ ...s, layers: { ...s.layers, [a.layerId]: false } });

    case "team.add":
      if (s.teams.some((t) => t.id === a.teamId)) return err("conflict", "identifiant d'équipe déjà pris");
      return ok({ ...s, teams: [...s.teams, { id: a.teamId, name: a.name, color: a.color, captainId: null }] });

    case "undo":
      return err("unsupported", "undo est résolu par le journal (game.ts)");

    default:
      return assertNever(a);
  }
}

function envOf(s: GameState, ctx: Ctx): MechanicEnv {
  return { at: ctx.at, rng: ctx.rng, phase: s.phase };
}

function present(s: GameState, a: ActionOf<"question.present">, ctx: Ctx, registry: Registry): R {
  if (s.phase !== "idle" || s.roundIndex === null) return err("wrong-phase", "démarrer une manche avant de présenter");
  const round = currentRound(s);
  if (round === null) return err("not-found", "manche inconnue");
  const index = a.questionIndex ?? (s.questionIndex === null ? 0 : s.questionIndex + 1);
  const qid = round.questions[index];
  const question = qid === undefined ? undefined : s.game.questions.find((q) => q.id === qid);
  if (question === undefined) return err("not-found", `question ${index} inexistante dans la manche`);
  const m = registry.get(round.mechanic);
  if (m === null) return err("unsupported", `mécanique inconnue : ${round.mechanic}`);
  const cfg = m.configSchema.safeParse(round.mechanicConfig);
  if (!cfg.success) return err("invalid", `configuration de mécanique invalide : ${cfg.error.message}`);
  const previous = s.carry !== null && s.carry.id === m.id ? { state: s.carry.state, revealed: s.carry.revealed, questionIndex: s.carry.questionIndex } : null;
  const init = m.init(cfg.data, question, envOf(s, ctx), { previous, questionIndex: index, questionsLeft: round.questions.length - index - 1 });
  if (!init.ok) return init;
  return ok({ ...s, phase: "presenting", questionIndex: index, mechanic: { id: m.id, state: init.value }, timer: null, openedAt: null, lockedAt: null, windowMs: null });
}

function reveal(s: GameState, ctx: Ctx, registry: Registry): R {
  if (s.phase !== "locked" && s.phase !== "judging") return err("wrong-phase", "verrouiller les réponses avant de révéler");
  const round = currentRound(s);
  const question = currentQuestion(s);
  if (round === null || question === null || s.mechanic === null) return err("conflict", "aucune question en cours");
  const m = registry.get(s.mechanic.id);
  if (m === null) return err("unsupported", `mécanique inconnue : ${s.mechanic.id}`);
  if (s.openedAt === null) return err("conflict", "réponses jamais ouvertes");
  const window = { openedAt: s.openedAt, durationMs: s.windowMs };
  const entries: ScoreEntry[] = [];
  const fixed: FixedJudgement[] = [];
  for (const j of m.judge(s.mechanic.state)) {
    switch (j.kind) {
      case "rule": {
        const p = s.participants.find((x) => x.id === j.participantId);
        if (p === undefined) continue; // removed meanwhile
        const delta = pointsFor(round.scoring, j, window);
        if (delta !== 0) entries.push(entry(ctx, entries.length, { participantId: p.id }, p.teamId, delta, "auto", null, question.id));
        break;
      }
      case "fixed":
        fixed.push(j);
        break;
      default:
        return assertNever(j);
    }
  }
  entries.push(...fixedEntries(s, ctx, fixed, question.id, entries.length));
  // Replaying a question (doc 09 "rejouer") replaces its automatic points instead of adding to them —
  // within the current round only: the same question used by another round keeps its points.
  const ledger = s.ledger.map((e, i) => (i >= s.roundLedgerStart && e.reason === "auto" && e.questionId === question.id && !e.voided ? { ...e, voided: true } : e));
  const played = s.played.includes(question.id) ? s.played : [...s.played, question.id];
  return ok({ ...s, phase: "revealed", timer: null, ledger: [...ledger, ...entries], played });
}

/** Ledger entries for mechanic-decided points (player or team target); 0 points and unknown targets write nothing. */
function fixedEntries(s: GameState, ctx: Ctx, judgements: readonly FixedJudgement[], questionId: string | null, from: number): ScoreEntry[] {
  const out: ScoreEntry[] = [];
  for (const j of judgements) {
    if (j.points === 0) continue;
    if ("participantId" in j.target) {
      const pid = j.target.participantId;
      const p = s.participants.find((x) => x.id === pid);
      if (p !== undefined) out.push(entry(ctx, from + out.length, { participantId: p.id }, p.teamId, j.points, "auto", null, questionId));
    } else {
      const tid = j.target.teamId;
      if (s.teams.some((t) => t.id === tid)) out.push(entry(ctx, from + out.length, { teamId: tid }, tid, j.points, "auto", null, questionId));
    }
  }
  return out;
}

function entry(ctx: Ctx, n: number, target: ScoreTarget, teamId: string | null, delta: number, reason: ScoreEntry["reason"], note: string | null, questionId: string | null): ScoreEntry {
  // Deterministic id derived from the event (ADR-0011).
  return { id: `se_${ctx.seq}_${n}`, target, teamId, delta, questionId, reason, note, by: ctx.actor, at: ctx.at, voided: false };
}

function addEntry(s: GameState, target: ScoreTarget, delta: number, reason: ScoreEntry["reason"], note: string | null, ctx: Ctx): R {
  let teamId: string | null;
  if ("participantId" in target) {
    const p = s.participants.find((x) => x.id === target.participantId);
    if (p === undefined) return err("not-found", "joueur inconnu");
    teamId = p.teamId; // frozen at scoring time: moving the player later never rewrites team totals
  } else {
    if (!s.teams.some((t) => t.id === target.teamId)) return err("not-found", "équipe inconnue");
    teamId = target.teamId;
  }
  if (delta === 0) return err("invalid", "variation nulle");
  const q = QUESTION_PHASES.has(s.phase) ? currentQuestion(s) : null;
  return ok({ ...s, ledger: [...s.ledger, entry(ctx, 0, target, teamId, delta, reason, note, q?.id ?? null)] });
}

function updateParticipant(s: GameState, id: string, f: (p: Participant) => Result<Participant, Rejection>): R {
  const p = s.participants.find((x) => x.id === id);
  if (p === undefined) return err("not-found", "joueur inconnu");
  const r = f(p);
  if (!r.ok) return r;
  return ok({ ...s, participants: s.participants.map((x) => (x.id === id ? r.value : x)) });
}

/** A player acts only for themselves, and only while active (control may act on their behalf). */
function checkPlayerIntent(s: GameState, participantId: string, ctx: Ctx): Result<Participant, Rejection> {
  if ((ctx.actor.role === "player" || ctx.actor.role === "seat") && ctx.actor.id !== participantId) {
    return err("forbidden", "un joueur n'agit que pour lui-même");
  }
  const p = s.participants.find((x) => x.id === participantId);
  if (p === undefined) return err("not-found", "joueur inconnu");
  if (p.status !== "active") return err("forbidden", `joueur ${p.status}`);
  return ok(p);
}

function mechanicAction(s: GameState, a: Action, ctx: Ctx, registry: Registry): R {
  return withMechanic(s, registry, (m, state) => m.onAction(state, a, envOf(s, ctx)) ?? err("unsupported", `la mécanique ${m.id} ne gère pas ${a.type}`));
}

function withMechanic(s: GameState, registry: Registry, f: (m: AnyMechanic, state: unknown) => Result<unknown, Rejection>): R {
  if (s.mechanic === null) return err("conflict", "aucune question en cours");
  const m = registry.get(s.mechanic.id);
  if (m === null) return err("unsupported", `mécanique inconnue : ${s.mechanic.id}`);
  const r = f(m, s.mechanic.state);
  if (!r.ok) return r;
  return ok({ ...s, mechanic: { id: m.id, state: r.value } });
}
