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
- `endsRound()` est consulté à `question.next` : `true` termine la manche tout de suite. Le `question.next`
  qui clôt une manche demande à la mécanique `closeRound()` : points `fixed` non écrits par une révélation.
- Les vues portent `teamBoard` (totaux d'équipe classés, y compris les lignes au nom d'une équipe).
- Les actions propres aux mécaniques (`buzz`, `answer.judge`, `element.reveal`, `joker.use`, `ladder.stop`,
  `poll.control`, `poll.steal`) passent par `onAction`. Le cœur vérifie avant : rôle, identité du joueur et
  statut actif (`buzz`), existence de l'équipe ou du joueur référencé ; la mécanique vérifie la phase.

### `mixed` (« Mixte », ADR-0015) — type de manche par défaut

Tous les types de question dans la même manche. `mixed` ne joue jamais lui-même : au `question.present`,
`playedBy()` (`route.ts`) choisit la mécanique selon le type de réponse (`MIXED_ROUTES`) et lui passe ses réglages
(`MixedConfig` : mélange des QCM, changement de réponse, erreurs du sondage, mode du nombre, blocage au buzzer).
`GameState.mechanic.id` est celui de la mécanique choisie.

### `poll-board` (« Une famille en or »)

Question `poll` (chaque option a une `value` en %, sinon refus à la présentation). Cases triées par valeur
décroissante. Config : `maxStrikes` (3), `multiplier` (1).
`poll.control { teamId }` donne la main (avant le premier jugement ; ensuite, undo) ; réponses ouvertes, la régie /
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
manche (`endsRound`, aussi après un `ladder.stop` non révélé). Le gain final est écrit **une fois** au
registre : au `question.reveal` qui termine la partie, sinon au `question.next` qui clôt la manche
(`closeRound` : dernière question passée, arrêt sans révélation → palier atteint avant la question). Les
révélations intermédiaires n'écrivent rien. Une question passée sans révélation ne fait pas monter ; revenir à
une question déjà jouée est refusé (passer par undo). Retirer le candidat remet la partie à zéro.
Risque connu : tout joueur actif peut devenir candidat par sa première réponse (le gabarit limite le format
à 1 participant ; la régie peut répondre pour lui).
Jokers (`joker.use`, avant la réponse et avant le verrouillage, une fois par partie chacun, visibles de
tous) : `fifty` masque 2 mauvaises options tirées par `ctx.rng` ; `audience` : le moteur tire le sondage par
`ctx.rng` (choix le plus simple, sans saisie régie) — 35 à 75 % pour la bonne réponse, le reste réparti au
hasard entre les autres options visibles, total 100. Avant révélation, `status`, `level` et `gain` ne
dépendent pas de la justesse de la réponse (testé).

### Mécaniques de la phase 3 (implémentées)

Capacités optionnelles du contrat : ADR-0013 (`freeOrder`, `hidesPromptMedia`, `projectIdle`, `regrade`,
`onSkip`, `RoundContext.questions`). Toutes passent `mechanicContractSuite`. Une réponse est conservée sous
forme texte (`PlayerView.myAnswer`, `ControlView.answers`) : `text` → [texte], `number` → [valeur],
`order` → ids, `pairs` → ["gauche:droite"], `pin` → ["x,y"], `allocation` → ["id:montant"].

- `text-answer` (question `text`, ou `single` jouée en saisie libre) : comparaison sans accents, casse,
  ponctuation ni article de tête (le, la, les, l', un, une, des, du, de, d', the, a, an), fautes tolérées
  selon la longueur (0 jusqu'à 4 lettres, 1 jusqu'à 8, sinon 2 ; `maxDistance` pour forcer), jamais sur
  les nombres (« 1789 » ≠ « 1788 »). Limite connue : retirer l'article de tête peut accepter un faux positif
  (« Land » pour « La La Land », « Moines » pour « Des Moines ») — ajouter la réponse exacte comme seule
  acceptée et `maxDistance: 0` dans ces cas. La régie (ou l'animateur) peut renverser un verdict
  (`answer.judge { participantId, correct }`) jusqu'à la révélation (liste `review` réservée régie / animateur).
- `number-answer` : `tolerance` (juste si |écart| ≤ tolérance) ou `closest` (le ou les plus proches gagnent,
  la tolérance vaut exact). Classement top 10 pour régie / sorties, jamais envoyé aux tablettes.
- `order` (3 à 8 propositions, affichées mélangées par la seed, jamais dans le bon ordre) : juste = ordre exact.
- `pairs` : colonne de droite mélangée, identifiants anonymes (`r0`…) ; juste = toutes les paires.
- `pin` (image obligatoire) : juste = point dans la zone cible (0..1). Épingles anonymes aux sorties à la
  révélation, jamais aux tablettes (poids).
- `allocation` (« Money Drop ») : tout le budget réparti, au moins une proposition vide (`keepOneEmpty`) ;
  points `fixed` = montant resté sur la bonne réponse.
- `board` (Jeopardy) : grille catégorie (1er tag) × valeur (`values[rang]`), questions `oral`, `text`
  ou `single` (les autres n'ont pas de case). La régie choisit la case (`question.present { questionIndex }`,
  ordre libre), buzz + jugement comme `buzzer` ; juste = + valeur, faux = − valeur (`penalty`). Grille
  projetée entre deux cases (`projectIdle`). Fin de manche quand toutes les cases sont jouées.
- `hints` : `hints[]` de la question dévoilés un à un (`element.reveal { index = suivant }`, le premier à la
  présentation) ; points `fixed` de `maxPoints` (1 indice) à `minPoints` (tous), figés à la réponse.
  Les indices cachés ne quittent jamais le serveur (sauf régie / animateur).
- `reveal-image` : l'image de la question découpée en `cols × rows` cases dévoilées dans un ordre tiré par la
  seed ; même barème que `hints`. Les tablettes ne reçoivent jamais l'image (ni vue, ni préchargement).

Rejouer une question à la même place (même manche, même index, y compris en relançant une manche déjà jouée
avec `round.start { roundIndex }`) annule les points de sa révélation précédente et les remplace ; la même
question jouée ailleurs garde ses points.

`crowd-vote` : révéler avant la fin de `streamDelayMs` après la fermeture refuse les votes encore en route
(révéler quelques secondes après, ou réduire le délai). L'animateur reçoit tout le conducteur (réponses et
notes, pour lire à l'avance) : son écran ne doit pas être visible des caméras ni du public.
`host.setDrive` ne s'annule jamais (`NEVER_UNDONE`) : reprendre la main = `host.setDrive { enabled: false }`.
`question.skip { roundIndex, questionIndex }` passe, entre deux questions, celle qui vient sans la jouer (question
injouable dans la manche, question abandonnée) : rien n'est marqué, elle n'entre ni dans `played` ni dans `history`
(le déroulé la montre « non jouée »). Cible explicite : un double appui est refusé. La dernière question passée
termine la manche comme une « Suivante » (une manche à paliers verse le palier atteint ; si la question passée est injouable dans la manche, rien n'est versé : corriger à la main). Refusé sur un plateau.
`game.patch` (studio, « Envoyer au direct », doc 07) non plus : renvoyer le document précédent. Il est refusé si
`baseVersion ≠ gameVersion` ; `question.regrade`, `question.edit`, `question.replaceFromReserve` et `game.patch`
incrémentent `gameVersion`. Règles de ce qui peut changer : `live-patch.ts` (`livePatchProblem`).

### Corrections en direct (phase 3, implémentées)

- `question.replaceFromReserve { reserveId, questionIndex? }` : question à l'antenne → remplacée et
  représentée de zéro (réponses perdues) ; entre deux questions → remplace la suivante (ou `questionIndex`).
  Refusé après la révélation (undo ou regrade), ou sur une place déjà révélée ; en ordre libre (plateau),
  préciser la case.
- `question.edit { text }` : corrige le texte de la question à l'antenne.
- `question.regrade { questionId, answerSpec }` (régie, scoreur) : même type de réponse ; chaque révélation
  de la question dans l'historique est rejugée (mécanique avec `regrade`), ses lignes `auto` / `regrade`
  annulées et réécrites (`reason: regrade`, équipe figée au moment du score d'origine), les lignes manuelles
  restent. Une ligne de la question annulée à la main (`score.void`) est réécrite par le regrade, et un verdict
  renversé à la main (`answer.judge`) reste prioritaire sur la nouvelle réponse. Aperçu sans journal :
  `POST /api/regrade/preview`. Annulable (undo).
- Départage (`format.tieBreak`) : `speed` = à total égal, le plus de bonnes réponses passe devant, puis le
  temps cumulé de ces bonnes réponses le plus court ; `control` = même rang, la régie tranche (manche de barrage
  `number-answer` en mode `closest`, ou points manuels).

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

- Une question **rejouée** (re-présentée puis révélée) remplace ses points automatiques précédents (annulés),
  dans la manche en cours seulement : la même question utilisée par une autre manche garde ses points.
- `round.start` sans index est refusé tant qu'il reste des questions dans la manche (sauter = index explicite).
- La dégressivité (`timeDecay`) suit la fenêtre du chrono réellement armé (prolongation comprise) ; sans chrono,
  pas de dégressivité.
- Chaque ligne de score fige l'équipe du joueur au moment du score : changer d'équipe ne réécrit pas l'historique.
- Un joueur retiré perd sa réponse en cours (un identifiant réutilisé n'hérite de rien).
- Arrondi symétrique (7,5 → 8 ; −7,5 → −8).
