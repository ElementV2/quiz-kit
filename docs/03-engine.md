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
`ladder` est une **mécanique de manche** (progression sur paliers). Ses paliers sont dans sa config
(`steps`, `safeSteps`), pas dans une `ScoringRule` : la règle de score de la manche est ignorée.

Toute mécanique passe `mechanicContractSuite` : actions hors phase rejetées, projection sans fuite,
rejeu déterministe, score cohérent avec le registre. La suite reçoit un générateur d'actions joueur
(`answerFor`), un générateur d'actions régie propres à la mécanique (`controlActionFor`) et un contrôle
de secrets propre à la mécanique (`assertNoLeak`) ; elle exige que ces actions soient souvent acceptées.

Le contrat réel est dans `packages/engine/src/mechanic.ts`. Points notables (phase 1) :

- `judge()` rend des `Judgement` `rule` (points calculés par la `ScoringRule` de la manche) ou `fixed`
  (points décidés par la mécanique, pour un joueur **ou une équipe** : banque de `poll-board`, gain de `ladder`).
  Les deux sont écrits au registre à `question.reveal` (raison `auto`), donc remplacés si la question est rejouée.
- `init()` reçoit le contexte de manche : l'état final de la question précédente de la même manche
  (`previous`, avec `revealed`) et le nombre de questions restantes. Le cœur le garde dans `GameState.carry`
  (vidé par `round.start`). Seules les mécaniques de manche (`ladder`) s'en servent.
- `endsRound()` est consulté à `question.next` : `true` termine la manche tout de suite.
- Les actions propres aux mécaniques (`buzz`, `answer.judge`, `element.reveal`, `joker.use`, `ladder.stop`,
  `poll.control`, `poll.steal`) passent par `onAction`. Le cœur vérifie avant : rôle, identité du joueur et
  statut actif (`buzz`), existence de l'équipe ou du joueur référencé ; la mécanique vérifie la phase.

### `poll-board` (« Une famille en or »)

Question `poll` (chaque option a une `value` en %, sinon refus à la présentation). Cases triées par valeur
décroissante. Config : `maxStrikes` (3), `multiplier` (1).
`poll.control { teamId }` donne la main (avant ou pendant les réponses) ; réponses ouvertes, la régie /
l'animateur valide la réponse orale : `answer.judge { optionId, correct: true }` trouve **et révèle** la case,
`answer.judge { correct: false }` donne une erreur. Toutes les cases trouvées → fin. À `maxStrikes`,
`poll.steal { teamId }` désigne l'équipe qui vole, dont la réponse unique est jugée de même.
Banque = somme des valeurs des cases trouvées × multiplicateur, à l'équipe qui vole si son vol est bon,
sinon à l'équipe qui a la main (verrouiller plus tôt = banque à l'équipe qui a la main).
`element.reveal { index }` retourne une case sans la compter (fin de manche « pour le spectacle ») ;
`question.reveal` ne retourne **pas** les cases restantes. Vue publique : une case masquée a `label` et
`value` à `null` (testé) ; animateur et régie voient tout.

### `buzzer` (culture G)

Questions `oral` (réponse attendue pour l'animateur) ou `single` (options lues, montrées à tous ; bonne
réponse à l'animateur et à la régie seulement). Réponses ouvertes = buzzers ouverts. Chaque `buzz` entre
dans la file dans l'ordre du journal : le premier journalisé a la main. La régie / l'animateur juge celui
qui a la main (`answer.judge { participantId, correct }`, refusé pour un autre joueur) : faux → il sort de la
file (bloqué pour la question si `lockoutOnWrong`, défaut `true`), la main passe au suivant ; juste → buzzers
fermés. Le jugement reste possible réponses verrouillées. Points à `question.reveal` par la `ScoringRule`
(base pour la bonne réponse, pénalité par mauvaise, dégressivité mesurée au buzz). Un `buzz` n'est jamais
la cible d'un undo par défaut. Vue joueur légère : `me` (main, position, bloqué, peut buzzer), sans file.

### `ladder` (QCM à paliers)

Questions `single`. Config : `steps` (montants strictement croissants), `safeSteps` (index des paliers
assurés, défaut `[]`), `jokers` (défaut `["fifty", "audience"]`). Le candidat est le premier joueur dont la
réponse est acceptée dans la manche ; les autres sont refusés. Bonne réponse révélée → palier suivant ;
mauvaise → retombe au dernier palier assuré atteint, fin ; `ladder.stop` (avant la réponse) garde le palier
atteint, fin ; dernier palier ou dernière question de la manche → fin. À la fin, `question.next` termine la
manche (`endsRound`). Le gain final est écrit **une fois** au registre, au `question.reveal` qui termine la
partie ; les révélations intermédiaires n'écrivent rien. Une question passée sans révélation ne fait pas
monter. Retirer le candidat remet la partie à zéro.
Jokers (`joker.use`, avant la réponse et avant le verrouillage, une fois par partie chacun, visibles de
tous) : `fifty` masque 2 mauvaises options tirées par `ctx.rng` ; `audience` : le moteur tire le sondage par
`ctx.rng` (choix le plus simple, sans saisie régie) — 35 à 75 % pour la bonne réponse, le reste réparti au
hasard entre les autres options visibles, total 100. Avant révélation, `status`, `level` et `gain` ne
dépendent pas de la justesse de la réponse (testé).

## Actions (extrait)

- Régie : `game.start`, `round.start`, `question.present`, `question.open`, `question.lock`,
  `answer.judge`, `element.reveal`, `question.reveal`, `question.next`, `score.adjust`, `score.void`,
  `question.regrade`, `question.replaceFromReserve`, `question.edit`, `timer.set`, `joker.use`,
  `layer.take`, `layer.out`, `player.add|rename|setStatus|setTeam|setSeat|remove`, `undo`.
- Joueurs : `answer.submit`, `buzz`, `vote`.
- Système : `timer.expired`, `client.connected`, `client.disconnected`.

Les rôles autorisés par action sont dans `schema` (`actionPermissions`) et vérifiés par le serveur **et** le moteur.

## Undo (ADR-0010)

`undo` est un événement du journal, toujours journalisé avec sa cible résolue (`targetSeq`) : le rejeu ne
devine jamais. Sans cible, il annule le dernier événement actif et effectif qui n'est ni une réponse joueur ni
un undo (un `timer.expired` compris : undo juste après un verrouillage auto = réponses rouvertes).
Un événement est actif si aucun undo actif ne le vise : annuler un undo = redo, annuler ce redo = re-undo, à
toute profondeur. `replay` ignore les événements annulés ; une action devenue invalide est listée dans `skipped`.
`replay` refuse un journal non contigu (`CorruptJournalError`) et ignore un snapshot invalide (rejeu complet).

## Overrides

Les actions de correction manuelle de la régie (`score.*`, `player.*`, `team.add`) sont acceptées quelle
que soit la phase, et tracées avec `reason: manual`. En live, l'humain a le dernier mot.
`timer.set` / `timer.stop` ne valent que réponses ouvertes (pour rouvrir : undo du verrouillage).

## Règles de score

- Une question **rejouée** (re-présentée puis révélée) remplace ses points automatiques précédents (annulés).
- `round.start` sans index est refusé tant qu'il reste des questions dans la manche (sauter = index explicite).
- La dégressivité (`timeDecay`) suit la fenêtre du chrono réellement armé (prolongation comprise) ; sans chrono,
  pas de dégressivité.
- Chaque ligne de score fige l'équipe du joueur au moment du score : changer d'équipe ne réécrit pas l'historique.
- Un joueur retiré perd sa réponse en cours (un identifiant réutilisé n'hérite de rien).
- Arrondi symétrique (7,5 → 8 ; −7,5 → −8).
