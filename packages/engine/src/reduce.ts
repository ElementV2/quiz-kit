import { HOST_DRIVE_ACTIONS, isAllowed, type Action, type ActionOf, type Actor, type Participant, type Round, type ScoreEntry, type ScoreTarget, ROLE_LABEL_FR, STATUS_LABEL_FR, actionLabel, answerKindLabel, mechanicLabel } from "@quiz/schema";
import { playedBy, scoringOf } from "./route.ts";
import { applyVerdicts, type ForcedVerdict } from "./verdicts.ts";
import type { AnyMechanic, FixedJudgement, Judgement, MechanicEnv, Registry } from "./mechanic.ts";
import { assertNever, err, ok, type Rejection, type Result } from "./result.ts";
import type { Rng } from "./rng.ts";
import { livePatchProblem } from "./live-patch.ts";
import { pointsFor, roundHalfAway, stakedRule } from "./scoring.ts";
import { currentQuestion, currentRound, participantTotal, teamTotal, type GameState, type QuestionRecord } from "./state.ts";

/** Everything comes from the event (ADR-0010): no clock, no global randomness. */
export type Ctx = { readonly at: number; readonly seq: number; readonly actor: Actor; readonly rng: Rng };

type R = Result<GameState, Rejection>;

const QUESTION_PHASES = new Set(["presenting", "open", "locked", "judging", "revealed"]);

/**
 * Pure core reducer. `undo` is not handled here: it is resolved over the journal by `game.ts`.
 * Overrides (score.*, player.*, team.add) are accepted in every phase (doc 03).
 */
export function reduce(s: GameState, action: Action, ctx: Ctx, registry: Registry): R {
  const hostDriving = ctx.actor.role === "host" && s.hostDrives && HOST_DRIVE_ACTIONS.has(action.type);
  if (!isAllowed(ctx.actor.role, action.type) && !hostDriving) {
    return err("forbidden", `${ROLE_LABEL_FR[ctx.actor.role]} ne peut pas ${actionLabel(action.type)}`);
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
      // Free order (board): phase idle inside the round always means cells are left (the last one ends the round).
      const free = current !== null && registry.get(current.mechanic)?.freeOrder === true;
      const remaining = current !== null && s.phase === "idle" && s.roundIndex !== null && (free || (s.questionIndex ?? -1) + 1 < current.questions.length);
      if (a.roundIndex === undefined && remaining) {
        return err("conflict", "il reste des questions dans la manche : préciser roundIndex pour sauter");
      }
      const following = nextRoundIndex(s);
      const index = a.roundIndex ?? following ?? -1;
      if (s.game.format.rounds[index] === undefined) return err("not-found", `manche ${index} inexistante`);
      return ok({ ...s, phase: "idle", roundIndex: index, questionIndex: null, carry: null, roundLedgerStart: s.ledger.length, stakes: null });
    }

    case "question.present":
      return present(s, a, ctx, registry);

    case "question.replaceFromReserve":
      return replaceFromReserve(s, a, ctx, registry);

    case "question.edit": {
      const q = QUESTION_PHASES.has(s.phase) ? currentQuestion(s) : null;
      if (q === null) return err("wrong-phase", "aucune question à l'antenne");
      return ok({ ...s, gameVersion: ctx.seq, game: { ...s.game, questions: s.game.questions.map((x) => (x.id === q.id ? { ...x, prompt: { ...x.prompt, text: a.text } } : x)) } });
    }

    case "question.regrade":
      return regrade(s, a, ctx, registry);

    case "game.patch": {
      if (a.baseVersion !== s.gameVersion) return err("conflict", "la partie en direct a changé depuis (corrections en régie ou autre envoi) : recharger la version du direct dans le studio");
      const currentMechanic = currentRound(s) === null ? null : registry.get(currentRound(s)?.mechanic ?? "");
      const problem = livePatchProblem(s, a.game, currentMechanic?.freeOrder === true);
      if (problem !== null) return err("conflict", problem);
      // Every mechanic config of the patched game must be valid for its mechanic (same check as at present).
      for (const r of a.game.format.rounds) {
        const m = registry.get(r.mechanic);
        if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${r.title}`);
        if (!m.configSchema.safeParse(r.mechanicConfig).success) return err("invalid", `réglages invalides pour la manche « ${r.title} »`);
      }
      // Stakes set ahead belong to a question: dropped if another question now sits at that place.
      const st = s.stakes;
      const keepStakes = st === null || s.game.format.rounds[st.roundIndex]?.questions[st.questionIndex] === a.game.format.rounds[st.roundIndex]?.questions[st.questionIndex];
      return ok({ ...s, game: a.game, gameVersion: ctx.seq, studioPatchedAt: ctx.at, stakes: keepStakes ? st : null });
    }

    case "question.setStakes": {
      // Explicit target, journaled as sent (review 5 I1): the current round, a question not revealed yet.
      if (s.roundIndex === null || a.roundIndex !== s.roundIndex) return err("conflict", "la mise vise une autre manche que la manche en cours");
      const round = currentRound(s);
      if (round === null || round.questions[a.questionIndex] === undefined) return err("not-found", "question inexistante dans la manche");
      const onAir = QUESTION_PHASES.has(s.phase) ? s.questionIndex : null;
      if (onAir === a.questionIndex && s.phase === "revealed") return err("wrong-phase", "question déjà révélée : corriger les points à la main ou rejouer");
      if (s.history.some((h) => h.roundIndex === a.roundIndex && h.questionIndex === a.questionIndex) && onAir !== a.questionIndex) return err("conflict", "question déjà jouée");
      const targetQ = s.game.questions.find((q) => q.id === round.questions[a.questionIndex]);
      const routed = targetQ === undefined ? null : playedBy(round, targetQ, registry);
      const m = routed?.ok === true ? routed.value.mechanic : registry.get(round.mechanic);
      if (m?.noStakes === true) return err("unsupported", "pas de mise sur les paliers : c'est le gain de toute la montée qui est en jeu");
      if (a.points !== null && m?.ownPoints === true) return err("unsupported", "cette mécanique décide de ses points : utiliser un multiplicateur (×2, ×5…)");
      // One stakes slot: a question on air keeps its stakes until it is left (review 6 m1).
      const onAirStaked = onAir !== null && s.stakes !== null && s.stakes.roundIndex === s.roundIndex && s.stakes.questionIndex === onAir;
      if (onAirStaked && a.questionIndex !== onAir) return err("conflict", "la question à l'antenne a une mise : la régler après elle");
      if (a.points === null && a.multiplier === null) return ok({ ...s, stakes: null });
      return ok({ ...s, stakes: { roundIndex: a.roundIndex, questionIndex: a.questionIndex, points: a.points, multiplier: a.multiplier } });
    }

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

    case "answer.verdict":
      return forceVerdict(s, a, ctx, registry);

    case "question.skip":
      return skipUpcoming(s, a, ctx, registry);

    case "question.next": {
      if (!QUESTION_PHASES.has(s.phase)) return err("wrong-phase", "aucune question en cours");
      const round = currentRound(s);
      const qi = s.questionIndex ?? 0;
      const m = s.mechanic === null ? null : registry.get(s.mechanic.id);
      const endsRound = m !== null && s.mechanic !== null && m.endsRound(s.mechanic.state, s.phase);
      const isLastQuestion = round === null || endsRound || (m?.freeOrder !== true && qi + 1 >= round.questions.length);
      const carry = s.mechanic === null ? s.carry : { id: s.mechanic.id, state: s.mechanic.state, revealed: s.phase === "revealed", questionIndex: qi };
      // A round ending here lets the mechanic bank what was not scored by a reveal (ladder skipped / stopped).
      const question = currentQuestion(s);
      const closing = isLastQuestion && m !== null && s.mechanic !== null && question !== null ? m.closeRound(s.mechanic.state, s.phase) : [];
      const skipped = s.phase !== "revealed" && m?.onSkip !== undefined && s.mechanic !== null ? m.onSkip(s.mechanic.state) : [];
      // Live stakes also apply to points written here (board cell judged then skipped, review 5 I3).
      const mult = stakesFor(s)?.multiplier ?? null;
      const staked = mult === null ? [...skipped, ...closing] : [...skipped, ...closing].map((j) => ({ ...j, points: roundHalfAway(j.points * mult) }));
      const ledger = [...s.ledger, ...fixedEntries(s, ctx, staked, question?.id ?? null, 0)];
      // Flow (format.flow): the round that follows depends on the final scores of this one; null = game over.
      const isLastRound = s.roundIndex === null || nextRoundIndex({ ...s, ledger }) === null;
      const phase = !isLastQuestion ? "idle" : isLastRound ? "game.end" : "round.end";
      // Stakes belong to one question: gone once it is left (unless set ahead for the next one).
      const stakes = s.stakes !== null && s.stakes.roundIndex === s.roundIndex && s.stakes.questionIndex === qi ? null : s.stakes;
      return ok({ ...s, phase, ledger, mechanic: null, carry, timer: null, openedAt: null, lockedAt: null, windowMs: null, stakes, verdicts: [] });
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
      if ((a.teamId === undefined) === (a.participantId === undefined)) return err("invalid", "désigner une équipe ou un joueur");
      if (a.teamId !== undefined && !s.teams.some((t) => t.id === a.teamId)) return err("not-found", "équipe inconnue");
      if (a.participantId !== undefined && !s.participants.some((p) => p.id === a.participantId)) return err("not-found", "joueur inconnu");
      return mechanicAction(s, a, ctx, registry);

    case "element.reveal":
    case "joker.use":
    case "ladder.stop":
    case "crowd.tally":
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
      if (s.participants.length >= s.game.format.participants.max) return err("conflict", `partie complète : « ${s.game.title} » accepte ${s.game.format.participants.max} joueur${s.game.format.participants.max > 1 ? "s" : ""} au maximum (la régie peut lancer une autre partie)`);
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
      // History too: a regrade must never give points to a later player reusing this id.
      const history = purged.history.map((h) => {
        const hm = registry.get(h.mechanicId);
        return { ...h, state: hm === null ? h.state : hm.removeParticipant(h.state, a.participantId), correctMs: h.correctMs.filter((x) => x.participantId !== a.participantId) };
      });
      if (s.mechanic === null) return ok({ ...purged, history });
      return withMechanic({ ...purged, history }, registry, (m, state) => ok(m.removeParticipant(state, a.participantId)));
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

    case "host.setDrive":
      if (s.hostDrives === a.enabled) return err("conflict", a.enabled ? "l'animateur pilote déjà" : "l'animateur ne pilote pas");
      return ok({ ...s, hostDrives: a.enabled });

    case "undo":
      return err("unsupported", "undo est résolu par le journal (game.ts)");

    default:
      return assertNever(a);
  }
}

/** Two best totals equal (teams when the game has teams, else players): what `when: tie` tests. */
function isTie(s: GameState): boolean {
  const totals = s.teams.length > 0 ? s.teams.map((t) => teamTotal(s, t.id)) : s.participants.map((p) => participantTotal(s, p.id));
  const [a, b] = totals.toSorted((x, y) => y - x);
  return a !== undefined && b !== undefined && a === b;
}

/**
 * Index of the round that follows the current one (null = game over): the first matching transition of
 * `format.flow` from this round, else the next round of the list. Before the first round: round 0.
 */
export function nextRoundIndex(s: GameState): number | null {
  const rounds = s.game.format.rounds;
  if (s.roundIndex === null) return rounds.length > 0 ? 0 : null;
  const current = rounds[s.roundIndex];
  const transitions = current === undefined ? [] : (s.game.format.flow ?? []).filter((t) => t.from === current.id);
  if (transitions.length === 0) return s.roundIndex + 1 < rounds.length ? s.roundIndex + 1 : null;
  const tie = isTie(s);
  for (const t of transitions) {
    if (t.when === "tie" && !tie) continue;
    if (t.when === "no-tie" && tie) continue;
    if (t.to === "end") return null;
    const i = rounds.findIndex((r) => r.id === t.to);
    return i < 0 ? null : i;
  }
  // Transitions exist but none matches (e.g. only `tie` and no tie): the list order applies.
  return s.roundIndex + 1 < rounds.length ? s.roundIndex + 1 : null;
}

function envOf(s: GameState, ctx: Ctx): MechanicEnv {
  return { at: ctx.at, rng: ctx.rng, phase: s.phase, lockedAt: s.lockedAt };
}

/**
 * `question.skip` between two questions: the upcoming question is passed without being played (e.g. it cannot be
 * played by this round, or the host drops it). Nothing is scored; the one after becomes the next. Never blocks the
 * show on one bad question. The last one passed ends the round like a normal « Suivante ».
 */
function skipUpcoming(s: GameState, a: ActionOf<"question.skip">, ctx: Ctx, registry: Registry): R {
  if (s.phase !== "idle" || s.roundIndex === null) return err("wrong-phase", "passer une question : seulement entre deux questions");
  const round = currentRound(s);
  if (round === null) return err("not-found", "manche inconnue");
  const m = registry.get(round.mechanic);
  if (m?.freeOrder === true) return err("conflict", "plateau : choisir directement une autre case");
  const index = (s.questionIndex ?? -1) + 1;
  if (index >= round.questions.length) return err("wrong-phase", "plus de question à passer dans cette manche");
  // Explicit target: a duplicate (double press, two posts) is refused instead of passing one more question.
  if (a.roundIndex !== s.roundIndex || a.questionIndex !== index) return err("conflict", "cette question n'est plus la suivante (déjà passée ou jouée)");
  const isLastQuestion = index + 1 >= round.questions.length;
  // The round ends here: the mechanic banks what it carried (ladder: the step reached), as if the passed question
  // had been presented then left unplayed — so its state is built like at present (progression of the previous one).
  let carried: readonly FixedJudgement[] = [];
  if (isLastQuestion && m !== null && s.carry !== null && s.carry.id === m.id) {
    const byId = new Map(s.game.questions.map((q) => [q.id, q]));
    const questions = round.questions.flatMap((id) => byId.get(id) ?? []);
    const question = questions[index];
    const played = question === undefined ? null : playedBy(round, question, registry);
    const init = played !== null && played.ok && played.value.mechanic.id === m.id && question !== undefined
      ? m.init(played.value.config, question, envOf(s, ctx), { previous: { state: s.carry.state, revealed: s.carry.revealed, questionIndex: s.carry.questionIndex }, questionIndex: index, questionsLeft: 0, questions })
      : null;
    // Unplayable here (the usual reason to pass it): nothing is built, nothing banked — never a refusal.
    if (init !== null && init.ok) carried = m.closeRound(init.value, "presenting");
  }
  const mult = stakesFor(s)?.multiplier ?? null;
  const staked = mult === null ? carried : carried.map((j) => ({ ...j, points: roundHalfAway(j.points * mult) }));
  const ledger = [...s.ledger, ...fixedEntries(s, ctx, staked, round.questions[index] ?? null, 0)]; // same question id as a last « Suivante »
  const isLastRound = nextRoundIndex({ ...s, ledger }) === null;
  const phase = !isLastQuestion ? "idle" : isLastRound ? "game.end" : "round.end";
  const stakes = s.stakes !== null && s.stakes.roundIndex === s.roundIndex && s.stakes.questionIndex === index ? null : s.stakes;
  return ok({ ...s, phase, questionIndex: index, stakes, ledger });
}

function present(s: GameState, a: ActionOf<"question.present">, ctx: Ctx, registry: Registry): R {
  if (s.phase !== "idle" || s.roundIndex === null) return err("wrong-phase", "démarrer une manche avant de présenter");
  const round = currentRound(s);
  if (round === null) return err("not-found", "manche inconnue");
  const m = registry.get(round.mechanic);
  if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${mechanicLabel(round.mechanic)}`);
  // GameDocument guarantees every round question exists (superRefine).
  const byId = new Map(s.game.questions.map((q) => [q.id, q]));
  const questions = round.questions.flatMap((id) => {
    const q = byId.get(id);
    return q === undefined ? [] : [q];
  });
  type Picked = Result<{ index: number; id: string; state: unknown }, Rejection>;
  const tryAt = (index: number): Picked => {
    const question = questions[index];
    if (question === undefined) return err("not-found", `question ${index} inexistante dans la manche`);
    // The mechanic that plays THIS question (a mixed round routes it by answer kind, ADR-0015).
    const played = playedBy(round, question, registry);
    if (!played.ok) return played;
    const pm = played.value.mechanic;
    const previous = s.carry !== null && s.carry.id === pm.id ? { state: s.carry.state, revealed: s.carry.revealed, questionIndex: s.carry.questionIndex } : null;
    const init = pm.init(played.value.config, question, envOf(s, ctx), { previous, questionIndex: index, questionsLeft: round.questions.length - index - 1, questions });
    return init.ok ? ok({ index, id: pm.id, state: init.value }) : init;
  };
  let picked: Picked;
  if (a.questionIndex === undefined && m.freeOrder === true) {
    // Free order (board): the first question the mechanic accepts (cells already played are refused).
    picked = err("conflict", "toutes les questions de la manche sont jouées");
    for (let i = 0; i < questions.length; i++) {
      const r = tryAt(i);
      if (r.ok) {
        picked = r;
        break;
      }
    }
  } else {
    picked = tryAt(a.questionIndex ?? (s.questionIndex === null ? 0 : s.questionIndex + 1));
  }
  if (!picked.ok) return picked;
  const { index, id, state } = picked.value;
  return ok({ ...s, phase: "presenting", questionIndex: index, mechanic: { id, state }, verdicts: [], timer: null, openedAt: null, lockedAt: null, windowMs: null });
}

function reveal(s: GameState, ctx: Ctx, registry: Registry): R {
  if (s.phase !== "locked" && s.phase !== "judging") return err("wrong-phase", "verrouiller les réponses avant de révéler");
  const round = currentRound(s);
  const question = currentQuestion(s);
  if (round === null || question === null || s.mechanic === null) return err("conflict", "aucune question en cours");
  const m = registry.get(s.mechanic.id);
  if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${mechanicLabel(s.mechanic.id)}`);
  if (s.openedAt === null) return err("conflict", "réponses jamais ouvertes");
  const window = { openedAt: s.openedAt, durationMs: s.windowMs };
  const stakes = stakesFor(s);
  const rule = stakedRule(scoringOf(round, question, registry), stakes); // a mixed round may score this kind its own way
  const entries: ScoreEntry[] = [];
  const fixed: FixedJudgement[] = [];
  for (const j of applyVerdicts(m.judge(s.mechanic.state), s.verdicts, s.openedAt)) {
    switch (j.kind) {
      case "rule": {
        const p = s.participants.find((x) => x.id === j.participantId);
        if (p === undefined) continue; // removed meanwhile
        const delta = pointsFor(rule, j, window);
        if (delta !== 0) entries.push(entry(ctx, entries.length, { participantId: p.id }, p.teamId, delta, "auto", null, question.id));
        break;
      }
      case "fixed":
        fixed.push(stakes?.multiplier == null ? j : { ...j, points: roundHalfAway(j.points * stakes.multiplier) });
        break;
      default:
        return assertNever(j);
    }
  }
  entries.push(...fixedEntries(s, ctx, fixed, question.id, entries.length));
  // Replaying a question (doc 09 "rejouer") replaces the points of its previous reveal at the same place
  // (round, question index) — including a regrade of it — instead of adding to them. The same question used
  // elsewhere (another round) keeps its points (review 2 B1: never by position in the ledger).
  const previousReveal = s.history.find((h) => h.roundIndex === (s.roundIndex ?? 0) && h.questionIndex === (s.questionIndex ?? 0));
  const replaced = new Set(previousReveal?.entryIds ?? []);
  const ledger = s.ledger.map((e) => (replaced.has(e.id) && !e.voided ? { ...e, voided: true } : e));
  const played = s.played.includes(question.id) ? s.played : [...s.played, question.id];
  const roundIndex = s.roundIndex ?? 0;
  const questionIndex = s.questionIndex ?? 0;
  const record = { roundIndex, questionIndex, questionId: question.id, mechanicId: m.id, state: m.compact === undefined ? s.mechanic.state : m.compact(s.mechanic.state), openedAt: s.openedAt, windowMs: s.windowMs, entryIds: entries.map((e) => e.id), correctMs: correctTimes(m, s.mechanic.state, s.openedAt), stakes, verdicts: s.verdicts };
  const history = [...s.history.filter((h) => h.roundIndex !== roundIndex || h.questionIndex !== questionIndex), record];
  return ok({ ...s, phase: "revealed", timer: null, ledger: [...ledger, ...entries], played, history });
}

/** Response time of each right answer (speed tie-break): buzz / answer time minus opening time. */
function correctTimes(m: AnyMechanic, state: unknown, openedAt: number): { participantId: string; ms: number }[] {
  const at = new Map(m.answers(state).map((x) => [x.participantId, x.at]));
  const out: { participantId: string; ms: number }[] = [];
  for (const j of m.judge(state)) {
    if (j.outcome !== "correct") continue;
    const pid = j.kind === "rule" ? j.participantId : "participantId" in j.target ? j.target.participantId : null;
    if (pid === null || out.some((x) => x.participantId === pid)) continue;
    const t = j.kind === "rule" ? j.answeredAt : at.get(pid);
    if (t !== undefined) out.push({ participantId: pid, ms: Math.max(0, t - openedAt) });
  }
  return out;
}

/** Ledger entries of a set of judgements (rule points use the round's ScoringRule and the given answer window). */
function judgementEntries(s: GameState, ctx: Ctx, judgements: readonly Judgement[], scoring: Round["scoring"], questionId: string, window: { openedAt: number; durationMs: number | null }, reason: ScoreEntry["reason"], stakes: Stakes | null): ScoreEntry[] {
  const entries: ScoreEntry[] = [];
  const fixed: FixedJudgement[] = [];
  const rule = stakedRule(scoring, stakes);
  for (const j of judgements) {
    if (j.kind === "fixed") {
      fixed.push(stakes?.multiplier == null ? j : { ...j, points: roundHalfAway(j.points * stakes.multiplier) });
      continue;
    }
    const p = s.participants.find((x) => x.id === j.participantId);
    if (p === undefined) continue;
    const delta = pointsFor(rule, j, window);
    if (delta !== 0) entries.push(entry(ctx, entries.length, { participantId: p.id }, p.teamId, delta, reason, null, questionId));
  }
  return [...entries, ...fixedEntries(s, ctx, fixed, questionId, entries.length).map((e) => ({ ...e, reason }))];
}

type Stakes = { readonly points: number | null; readonly multiplier: number | null };
export { stakedRule };

/** Stakes set for the question on air (null when none, or set for another question). */
function stakesFor(s: GameState): Stakes | null {
  const st = s.stakes;
  return st !== null && st.roundIndex === s.roundIndex && st.questionIndex === s.questionIndex ? { points: st.points, multiplier: st.multiplier } : null;
}


function replaceFromReserve(s: GameState, a: ActionOf<"question.replaceFromReserve">, ctx: Ctx, registry: Registry): R {
  const round = currentRound(s);
  if (round === null || s.roundIndex === null) return err("wrong-phase", "aucune manche en cours");
  if (!round.reserve.includes(a.reserveId)) return err("not-found", "question absente de la réserve de la manche");
  const onAir = s.phase === "presenting" || s.phase === "open" || s.phase === "locked" || s.phase === "judging";
  if (!onAir && s.phase !== "idle") return err("wrong-phase", s.phase === "revealed" ? "question déjà révélée : annuler (undo) ou corriger (regrade)" : "aucune question à remplacer");
  const free = registry.get(round.mechanic)?.freeOrder === true;
  if (!onAir && free && a.questionIndex === undefined) return err("invalid", "ordre libre : préciser la case à remplacer (questionIndex)");
  const index = onAir ? (s.questionIndex ?? 0) : (a.questionIndex ?? (s.questionIndex === null ? 0 : s.questionIndex + 1));
  if (round.questions[index] === undefined) return err("not-found", `question ${index} inexistante dans la manche`);
  const ri = s.roundIndex;
  if (s.history.some((h) => h.roundIndex === ri && h.questionIndex === index)) return err("conflict", "cette question a déjà été révélée : annuler (undo) ou corriger (regrade)");
  const rounds = s.game.format.rounds.map((r, i) =>
    i === ri ? { ...r, questions: r.questions.map((q, qi) => (qi === index ? a.reserveId : q)), reserve: r.reserve.filter((q) => q !== a.reserveId) } : r,
  );
  const swapped: GameState = { ...s, gameVersion: ctx.seq, game: { ...s.game, format: { ...s.game.format, rounds } } };
  if (!onAir) return ok(swapped);
  // The replaced question restarts from scratch: no answer given to the old one is kept.
  return present({ ...swapped, phase: "idle" }, { type: "question.present", questionIndex: index }, ctx, registry);
}

/**
 * `question.regrade`: new answer (same kind) written into the game, then every reveal of that question is
 * judged again: its automatic entries are voided, new ones written with `reason: regrade` (manual ones stay).
 */
/** Upserts (or removes, `correct: null`) one forced verdict. */
function withVerdict(list: readonly ForcedVerdict[], participantId: string, correct: boolean | null): ForcedVerdict[] {
  const rest = list.filter((v) => v.participantId !== participantId);
  return correct === null ? rest : [...rest, { participantId, correct }];
}

/**
 * `answer.verdict`: one participant judged right / wrong by hand, on the question on air (applied at its reveal) or
 * on a revealed one (that record is rescored at once: its entries voided and rewritten, team at the time kept).
 */
function forceVerdict(s: GameState, a: ActionOf<"answer.verdict">, ctx: Ctx, registry: Registry): R {
  if (!s.participants.some((p) => p.id === a.participantId) && !s.ledger.some((e) => "participantId" in e.target && e.target.participantId === a.participantId)) {
    return err("not-found", "joueur inconnu");
  }
  const onAir = s.mechanic !== null && s.roundIndex === a.roundIndex && s.questionIndex === a.questionIndex && QUESTION_PHASES.has(s.phase);
  const record = s.history.find((h) => h.roundIndex === a.roundIndex && h.questionIndex === a.questionIndex);
  const mechanicId = onAir && s.mechanic !== null ? s.mechanic.id : record?.mechanicId;
  const m = mechanicId === undefined ? null : registry.get(mechanicId);
  if (m === null) return err("conflict", "question pas encore jouée");
  if (a.correct === true && m.ownPoints === true) return err("unsupported", "ici la manche décide de ses points : compter faux, ou ajuster le score à la main");
  if (onAir && s.phase !== "revealed") return ok({ ...s, verdicts: withVerdict(s.verdicts, a.participantId, a.correct) });
  if (record === undefined) return err("conflict", "question pas encore révélée");
  const round = s.game.format.rounds[record.roundIndex];
  if (round === undefined) return err("not-found", "manche inconnue");
  const verdicts = withVerdict(record.verdicts, a.participantId, a.correct);
  const voided = new Set(record.entryIds);
  const teamAtScoring = new Map<string, string | null>();
  for (const e of s.ledger) if (voided.has(e.id) && "participantId" in e.target) teamAtScoring.set(e.target.participantId, e.teamId);
  const ledger = s.ledger.map((e) => (voided.has(e.id) && !e.voided ? { ...e, voided: true } : e));
  const fresh = judgementEntries({ ...s, ledger }, ctx, applyVerdicts(m.judge(record.state), verdicts, record.openedAt ?? 0), scoringOf(round, s.game.questions.find((x) => x.id === record.questionId), registry), record.questionId, { openedAt: record.openedAt ?? 0, durationMs: record.windowMs }, "regrade", record.stakes).map((e, i) => ({
    ...e,
    id: `se_${ctx.seq}_${ledger.length + i}`,
    teamId: "participantId" in e.target && teamAtScoring.has(e.target.participantId) ? (teamAtScoring.get(e.target.participantId) ?? null) : e.teamId,
  }));
  const history = s.history.map((h) => (h === record ? { ...h, verdicts, entryIds: fresh.map((e) => e.id) } : h));
  return ok({ ...s, ledger: [...ledger, ...fresh], history, verdicts: onAir ? verdicts : s.verdicts });
}

function regrade(s: GameState, a: ActionOf<"question.regrade">, ctx: Ctx, registry: Registry): R {
  const old = s.game.questions.find((q) => q.id === a.questionId);
  if (old === undefined) return err("not-found", "question inconnue");
  if (old.answerSpec.kind !== a.answerSpec.kind) return err("invalid", `même type de réponse attendu (« ${answerKindLabel(old.answerSpec.kind)} »)`);
  const question = { ...old, answerSpec: a.answerSpec };
  const records = s.history.filter((h) => h.questionId === a.questionId);
  const live = s.mechanic !== null && currentQuestion(s)?.id === a.questionId ? s.mechanic : null;
  if (records.length === 0 && live === null) return err("conflict", "question jamais jouée : modifier la question dans le studio");
  let ledger = s.ledger;
  const history: QuestionRecord[] = [];
  for (const h of s.history) {
    if (h.questionId !== a.questionId) {
      history.push(h);
      continue;
    }
    const m = registry.get(h.mechanicId);
    const round = s.game.format.rounds[h.roundIndex];
    const r = m?.regrade?.(h.state, question) ?? null;
    if (m === null || round === undefined || r === null) return err("unsupported", `une manche « ${mechanicLabel(h.mechanicId)} » ne se corrige pas après coup (juger / ajuster le score)`);
    if (!r.ok) return r;
    const voided = new Set(h.entryIds);
    // Team at the time of the original scoring (a player moved since keeps crediting their old team).
    const teamAtScoring = new Map<string, string | null>();
    for (const e of ledger) if (voided.has(e.id) && "participantId" in e.target) teamAtScoring.set(e.target.participantId, e.teamId);
    ledger = ledger.map((e) => (voided.has(e.id) && !e.voided ? { ...e, voided: true } : e));
    const fresh = judgementEntries({ ...s, ledger }, ctx, applyVerdicts(m.judge(r.value), h.verdicts, h.openedAt ?? 0), scoringOf(round, question, registry), question.id, { openedAt: h.openedAt ?? 0, durationMs: h.windowMs }, "regrade", h.stakes)
      .map((e, i) => ({
        ...e,
        // Unique ids across several records rewritten by the same event.
        id: `se_${ctx.seq}_${ledger.length + i}`,
        teamId: "participantId" in e.target ? (teamAtScoring.has(e.target.participantId) ? (teamAtScoring.get(e.target.participantId) ?? null) : e.teamId) : e.teamId,
      }));
    ledger = [...ledger, ...fresh];
    history.push({ ...h, state: r.value, entryIds: fresh.map((e) => e.id), correctMs: correctTimes(m, r.value, h.openedAt ?? 0) });
  }
  let mechanic = s.mechanic;
  if (live !== null) {
    const m = registry.get(live.id);
    const r = m?.regrade?.(live.state, question) ?? null;
    if (r === null) return err("unsupported", `une manche « ${mechanicLabel(live.id)} » ne se corrige pas après coup`);
    if (!r.ok) return r;
    mechanic = { id: live.id, state: r.value };
  }
  return ok({ ...s, gameVersion: ctx.seq, game: { ...s.game, questions: s.game.questions.map((q) => (q.id === question.id ? question : q)) }, ledger, history, mechanic });
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
  if (p.status !== "active") return err("forbidden", `joueur ${STATUS_LABEL_FR[p.status]}`);
  return ok(p);
}

function mechanicAction(s: GameState, a: Action, ctx: Ctx, registry: Registry): R {
  return withMechanic(s, registry, (m, state) => m.onAction(state, a, envOf(s, ctx)) ?? err("unsupported", `impossible de ${actionLabel(a.type)} dans une manche « ${mechanicLabel(m.id)} »`));
}

function withMechanic(s: GameState, registry: Registry, f: (m: AnyMechanic, state: unknown) => Result<unknown, Rejection>): R {
  if (s.mechanic === null) return err("conflict", "aucune question en cours");
  const m = registry.get(s.mechanic.id);
  if (m === null) return err("unsupported", `type de manche inconnu de cette version : ${mechanicLabel(s.mechanic.id)}`);
  const r = f(m, s.mechanic.state);
  if (!r.ok) return r;
  return ok({ ...s, mechanic: { id: m.id, state: r.value } });
}
