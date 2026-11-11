# ADR-0016 — Mécanique qui traverse les manches (« La chaîne ») : banque de partie et vote d'élimination

- Statut : accepté
- Date : 2026-11-11

## Contexte
Le format « La chaîne » (façon Maillon faible, décision produit du 2026-11-11) a des règles qui dépassent une manche :
- la **banque** de chaque manche de chaîne s'additionne sur toute la partie, et n'est versée en points qu'au vainqueur
  du duel final (avant, les banques sont montrées, jamais comptées) ;
- après chaque manche de chaîne, un **vote d'élimination** se joue **entre deux manches** (aucune question à l'antenne),
  avec un départage par le maillon fort de la manche, et il change le **statut** d'un joueur ;
- l'ordre de passage et le duel final dépendent des **joueurs actifs**, qu'une mécanique ne connaissait pas.

Le contrat de mécanique (ADR-0002, ADR-0013) ne portait l'état d'une mécanique que le temps d'une manche
(`GameState.carry`, vidé par `round.start`), n'acceptait d'action que question à l'antenne (`withMechanic`), et ne
pouvait toucher ni aux joueurs ni à leur statut.

## Décision
Trois capacités optionnelles de plus dans `packages/engine/src/mechanic.ts`, sans effet pour les mécaniques qui ne les
déclarent pas :

1. **`spansRounds`** : l'état laissé par chaque `question.next` est aussi rangé dans **`GameState.across[id]`**
   (`{ state, roundIndex }`), que `round.start` ne vide pas. La première question d'une manche reçoit cet état dans
   `RoundContext.earlier` (`previous` reste l'état de la question précédente de la même manche). Hors antenne (phases
   `idle`, `round.end`), les actions propres à la mécanique (`chain.*`, routées par `spanningAction` dans `reduce.ts`)
   s'appliquent à cet état — et à `carry` s'il est de la même manche, pour que la question suivante en parte. Il est
   projeté hors antenne (`idle`, `round.end`, `game.end`). Il est validé par le `stateSchema` de la mécanique à la
   relecture d'un snapshot, et purgé par `player.remove` comme `carry` et `history`.
2. **`eliminates(before, after)`** : la mécanique dit quels joueurs une action acceptée élimine ; **le cœur** passe
   leur statut à `eliminated` (seulement s'ils étaient actifs). La mécanique ne modifie jamais les joueurs elle-même.
3. **`pending(state)`** : état de partie non réglé (vote ouvert ou à départager) → `round.start` et
   `question.present` refusés avec sa raison (« terminer le vote d'élimination d'abord »), **quelle que soit la manche
   suivante** (même une manche qui n'est pas une chaîne : sinon le vote resterait bloqué, invisible et injouable).
4. **`holdsRound(state)`** : l'état ne peut pas clore sa manche en silence (duel sans vainqueur) → le `question.next`, le
   `question.skip` ou le `round.start` (saut depuis la manche) qui la clorait est refusé avec sa raison.
5. **`noForcedVerdict`** : `answer.verdict` refusé (le verdict est le jugement en direct ; le corriger = annuler le
   jugement), sinon banque / vainqueur et verdict forcé divergeraient.
6. Une action hors antenne qui **termine la manche entre deux tours** (`chain.end`) la termine pour de bon : phase
   `round.end` (ou `game.end`), comme un « Suivante » — la touche « Suivant » mène alors au vote puis à la manche suivante.
7. **`MechanicEnv.activePlayers`** (joueurs actifs, ordre d'inscription) et **`MechanicEnv.roundIndex`** ;
   `RoundContext.roundIndex`. Absents lors d'un contrôle statique (problèmes de manche du studio) : la mécanique ne
   vérifie alors que la question et ses réglages.

Où vit quoi, pour `chain` :
- **banque** : `bank` (manche en cours) + `banks[]` (une ligne par manche de chaîne passée, par index de manche) dans
  l'état de la mécanique. Rejouer une manche remplace sa ligne ; un duel gagné a payé la cagnotte (une chaîne jouée
  après repart de zéro). Le **registre** (`ledger`) ne reçoit qu'une ligne : la cagnotte au vainqueur du duel
  (`fixed`, à la révélation de la question décisive, sinon au `question.next` qui clôt le duel via `closeRound`).
- **vote** : `vote` dans l'état de la dernière question de la manche, modifié entre deux manches ; secret par rôle dans
  `project()` (bulletins et décompte `null` pour joueurs et sorties tant qu'il est ouvert ; chacun voit son vote).
- **statut** : `Participant.status`, posé par le cœur (`eliminates`) — même statut que `player.setStatus`, donc
  tablettes, `canAnswer`, rotation des tours et votes suivants le voient sans code de plus.

Tout est dans `GameState` (journalisé avant diffusion, rejoué, annulable par `undo`) : reconnexion et reprise après
crash rendent la même partie.

Règles explicites ajoutées après relecture :
- **Duel sans vainqueur** quand ses questions sont épuisées (égalité en mort subite) : jamais de fin silencieuse. Le
  dernier « Suivante » est refusé (« duel sans vainqueur : ajouter des questions… ») ; la régie ajoute des questions
  (studio, « Envoyer au direct ») ou termine le duel **sans vainqueur** (`chain.end`, permis dans le duel tant qu'il n'a
  pas de vainqueur) : la cagnotte n'est pas versée, à corriger à la main si besoin. Un duel cassé (joueur retiré) peut se
  quitter.
- **Clore un vote sans aucun bulletin** est refusé (« aucun vote reçu ») : tous seraient à égalité. La régie peut voter
  pour les joueurs (`chain.vote`), ou annuler l'ouverture.
- **Égalité devenue impossible à départager** (les ex aequo retirés, ou seul le maillon fort reste) : le vote se
  rouvre (bulletins des retirés supprimés), à clore de nouveau.
- Les décisions d'un joueur (`chain.bank`, `chain.vote`, `chain.pick`) ne sont jamais la cible d'un `undo` sans cible
  (comme une réponse) ; un `undo` ciblé reste possible.
- Vue : `canOpenVote` dit si un vote peut s'ouvrir maintenant (manche finie, pas de vote, 3 joueurs actifs ou plus) ;
  `nextStep` (`packages/protocol`) propose ouvrir / clore le vote avant la manche suivante, et rien pendant un départage.

## Alternatives écartées
- Champ dédié `GameState.chain` dans le cœur — refusé : règle d'une mécanique dans le réducteur (principe O). La
  capacité `spansRounds` resservira (tournoi, cagnotte cumulée).
- Banque écrite au registre à chaque manche puis « transférée » au vainqueur — refusé : les classements montreraient des
  points que personne n'a encore gagnés, et le transfert serait une écriture artificielle (le produit veut « aucun point
  avant la fin »).
- Banque recalculée depuis `history` — refusé : une banque peut se faire sans révélation (question passée), et
  `history` ne garde que les questions révélées.
- Vote joué comme une « question » d'une manche à part — refusé : une manche exige des questions, le vote n'en a pas,
  et la régie verrait une fausse question dans le déroulé.
- Statut posé par la régie à la main après le vote — refusé : deux gestes pour une décision, source d'erreur en live.
  Elle garde la main (`player.setStatus` reste possible, un statut changé à la main n'est pas écrasé).
- Chrono de manche (le vrai Maillon faible joue la chaîne contre la montre) — non fait : le moteur n'a pas de chrono de
  manche (`timer` est par question, armé à l'ouverture des réponses), et le serveur n'injecte `timer.expired` que pour lui. La
  manche s'arrête quand la banque est pleine, quand ses questions sont épuisées, ou par la régie (`chain.end`). Voir
  `docs/OPEN-QUESTIONS.md`.

## Conséquences
- Une action `chain.*` hors antenne refusée l'est avec un message clair (« le vote se fait entre deux manches »…).
- Un vote ouvert (ou à départager) bloque la manche suivante, quelle qu'elle soit : le clore, ou l'annuler (`undo`).
- Les réglages d'une manche en cours ne changent pas (`livePatchProblem`) ; ceux d'une manche de chaîne suivante, si.
- À surveiller : `envOf` calcule la liste des joueurs actifs à chaque action (O(n), négligeable à 500 joueurs) ; la vue
  `chain` est projetée par spectateur hors antenne (petite : quelques joueurs).
