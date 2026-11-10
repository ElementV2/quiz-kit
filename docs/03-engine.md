# 03 — Moteur (`packages/engine`)

## API publique

```ts
type Ctx = { rng: Rng; at: number; actor: Actor; seq: number }   // tout vient de l'événement (ADR-0010)

reduce(state: GameState, action: Action, ctx: Ctx): Result<Outcome, Rejection>   // Outcome = { state, effects }
project(state: GameState, viewer: Viewer): View          // vue filtrée par rôle
replay(initial: GameState, events: Event[]): ReplayResult // { state, skipped[] }, applique les `undo`
initialState(session: Session, game: GameSnapshot): GameState
createRegistry() / registry.register(m: Mechanic)
```

Pur : mêmes entrées → même sortie. Aucun accès horloge, réseau, disque, `Math.random`.
`ctx.rng` est un PRNG seedé par `seed de session + seq` (pour les tirages de questions ou l'ordre de passage).
`ctx.at` est l'heure murale serveur de l'événement : c'est la seule notion de temps du moteur.

## État de jeu

`GameState` = { session, game (contenu + format figés), participants, teams, scoreLedger, roundIndex,
questionIndex, phase, mechanicState, revealed, timer (échéance en heure murale), layers (TAKE/OUT), jokersUsed }.
Pas de `history` : l'undo passe par le journal (ADR-0010).

## Cycle par défaut d'une question

`idle → presenting → open → locked → judging → revealed → idle | round.end`

Chaque mécanique peut ajouter des sous-phases (indices, slots, duel) mais garde ce squelette.

## Contrat d'une mécanique

```ts
interface Mechanic<C, S> {
  id: string
  configSchema: ZodType<C>
  init(cfg: C, question: Question, ctx): Result<S, Rejection>
  onAction(s: S, a: Action, env: MechanicEnv): Result<{ state: S; score: ScoreDraft[] }, Rejection> | null  // null = pas concernée
  project(s: S, env: ProjectEnv): MechanicView  // ce que chaque rôle voit (filtrée selon viewer + phase)
  actionsFor(s: S, env: ProjectEnv): ActionHint[] // boutons contextuels régie / tablette
}
```

Mécaniques de base (phase 0 → 3) : `choice` (QCM, vrai/faux, multi), `poll-board` (Famille en or),
`buzzer` (priorité + blocage), `ladder` (paliers), `oral` (validation animateur), `text-answer` (fuzzy),
`number-answer`, `order`, `pairs`, `pin`, `board` (Jeopardy), `hints` (indices dégressifs), `reveal-image`,
`allocation`, `crowd-vote` (majorité chat).
`ladder` est une **mécanique de manche** (progression sur paliers) qui s'appuie sur une `ScoringRule` `ladder`.

Toute mécanique passe `mechanicContractSuite` : actions hors phase rejetées, projection sans fuite,
rejeu déterministe, score cohérent avec le registre.

## Actions (extrait)

- Régie : `game.start`, `round.start`, `question.present`, `question.open`, `question.lock`,
  `answer.judge`, `element.reveal`, `question.reveal`, `question.next`, `score.adjust`, `score.void`,
  `question.regrade`, `question.replaceFromReserve`, `question.edit`, `timer.set`, `joker.use`,
  `layer.take`, `layer.out`, `player.add|rename|setStatus|setTeam|setSeat|remove`, `undo`.
- Joueurs : `answer.submit`, `buzz`, `vote`.
- Système : `timer.expired`, `client.connected`, `client.disconnected`.

Les rôles autorisés par action sont dans `schema` (`actionPermissions`) et vérifiés par le serveur **et** le moteur.

## Undo (ADR-0010)

`undo` est un événement du journal. Sans cible, il annule la dernière action **de la régie** non annulée
(jamais une réponse joueur). `replay` rejoue tout en ignorant les événements annulés ; une action devenue
invalide est ignorée et listée dans `skipped`. Annuler un `undo` = redo.

## Overrides

Les actions de correction manuelle de la régie (`score.adjust`, `score.void`, `player.*`, `timer.set`)
sont acceptées quelle que soit la phase. Elles sont tracées avec `reason: manual`. En live, l'humain a le dernier mot.
