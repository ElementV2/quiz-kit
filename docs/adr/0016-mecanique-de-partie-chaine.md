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
3. **`MechanicEnv.activePlayers`** (joueurs actifs, ordre d'inscription) et **`MechanicEnv.roundIndex`** ;
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
  manche (`timer` est par question, armé à `question.open`), et le serveur n'injecte `timer.expired` que pour lui. La
  manche s'arrête quand la banque est pleine, quand ses questions sont épuisées, ou par la régie (`chain.end`). Voir
  `docs/OPEN-QUESTIONS.md`.

## Conséquences
- Une action `chain.*` hors antenne refusée l'est avec un message clair (« le vote se fait entre deux manches »…).
- Un vote ouvert (ou à départager) bloque la présentation de la manche suivante : le clore, ou l'annuler (`undo`).
- Changer les réglages (`game.patch`) en cours de manche de chaîne ne s'applique qu'à la manche suivante (montants et
  banque maximale lus à la première question).
- À surveiller : `envOf` calcule la liste des joueurs actifs à chaque action (O(n), négligeable à 500 joueurs) ; la vue
  `chain` est projetée par spectateur hors antenne (petite : quelques joueurs).
