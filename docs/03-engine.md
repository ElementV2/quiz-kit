# 03 — Moteur (`packages/engine`)

## API publique

```ts
reduce(state: GameState, action: Action, ctx: { rng: Rng }): Result<GameState, Rejection>
project(state: GameState, viewer: Viewer): View          // vue filtrée par rôle
replay(snapshot: GameState, events: Event[]): GameState
initialState(session: Session): GameState
registerMechanic(m: Mechanic): void
```

Pur : mêmes entrées → même sortie. Aucun accès horloge, réseau, disque, `Math.random`.
`ctx.rng` est un PRNG seedé (seed de session + seq), pour les tirages de questions ou l'ordre de passage.

## État de jeu

`GameState` = { session, participants, teams, scoreLedger, roundIndex, questionIndex, phase,
mechanicState, revealed (ce qui est révélé, par élément), timers (échéances logiques), layers (TAKE/OUT),
jokersUsed, history (pour undo) }.

## Cycle par défaut d'une question

`idle → presenting → open → locked → judging → revealed → idle | round.end`

Chaque mécanique peut ajouter des sous-phases (indices, slots, duel) mais garde ce squelette.

## Contrat d'une mécanique

```ts
interface Mechanic<C, S, A extends Action> {
  id: string
  configSchema: ZodType<C>
  init(cfg: C, ctx): S
  accepts(action: Action): action is A
  reduce(s: S, a: A, ctx): Result<S, Rejection>
  score(s: S, a: A, ctx): ScoreEntry[]          // lignes ajoutées au registre
  project(s: S, viewer: Viewer): Partial<View>  // ce que chaque rôle voit
  actionsFor(s: S, viewer: Viewer): ActionHint[] // boutons contextuels régie / tablette
}
```

Mécaniques de base (phase 1 → 3) : `choice` (QCM, vrai/faux, multi), `poll-board` (Famille en or),
`buzzer` (priorité + blocage), `ladder` (paliers), `text-answer` (fuzzy), `number-answer`,
`order`, `board` (Jeopardy), `hints` (indices dégressifs), `reveal-image`, `allocation`, `crowd-vote` (majorité chat).

Toute mécanique passe `mechanicContractSuite` : actions hors phase rejetées, projection sans fuite,
rejeu déterministe, score cohérent avec le registre.

## Actions (extrait)

- Régie : `game.start`, `round.start`, `question.present`, `question.open`, `question.lock`,
  `answer.judge`, `element.reveal`, `score.adjust`, `score.void`, `question.regrade`,
  `question.replaceFromReserve`, `question.edit`, `timer.set`, `joker.use`, `layer.take`, `layer.out`,
  `player.add|rename|setStatus|setTeam|setSeat|remove`, `undo`.
- Joueurs : `answer.submit`, `buzz`, `vote`.
- Système : `timer.expired`, `client.connected`, `client.disconnected`.

## Undo

`undo` retire la dernière action **de la régie** (pas les réponses des joueurs) : le serveur reconstruit
l'état depuis le dernier snapshot en rejouant le journal sans l'action annulée (marquée `voided`, jamais supprimée).

## Overrides

Les actions de correction manuelle de la régie sont toujours acceptées, quelle que soit la phase.
Elles sont tracées avec `reason: manual`. En live, l'humain a le dernier mot.
