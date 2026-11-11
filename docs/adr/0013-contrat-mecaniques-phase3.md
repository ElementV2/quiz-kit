# ADR-0013 — Extensions du contrat de mécanique (phase 3)

- Statut : accepté
- Date : 2026-11-11

## Contexte
La phase 3 ajoute neuf mécaniques (`text-answer`, `number-answer`, `order`, `pairs`, `pin`, `allocation`,
`board`, `hints`, `reveal-image`) et des corrections en direct (`question.regrade`, réserve, édition).
Le contrat de l'ADR-0002 (mécanique = `init` / `submit` / `onAction` / `judge` / `project`) ne permettait pas :
un plateau joué dans n'importe quel ordre (Jeopardy), une image qui ne doit jamais atteindre les tablettes,
une vue entre deux questions (la grille du plateau), ni de rejuger une question déjà passée.

## Décision
Le contrat (`packages/engine/src/mechanic.ts`) reçoit des **capacités optionnelles** ; une mécanique qui ne
les déclare pas garde exactement le comportement d'avant :

- `RoundContext.questions` : toutes les questions de la manche, dans l'ordre (le plateau en tire sa grille).
- `freeOrder` : `question.present` sans index prend la première question que `init` accepte ; seule
  `endsRound` termine la manche (pas le dernier index) ; `round.start` sans index est refusé tant que la
  manche est en cours.
- `hidesPromptMedia` : le `question.prompt.media` n'est jamais projeté aux joueurs, et le serveur ne le
  précharge pas sur les tablettes (`tabletMediaHashes`, `/media` n'exige pas de jeton).
- `projectIdle(config, questions, previous, env)` : vue projetée en phase `idle` (grille entre deux cases).
- `regrade(state, question)` : mêmes réponses, rejugées contre la question corrigée (même type de réponse).
  Absent : la question ne se corrige pas après coup (mécaniques jugées par un humain : buzzer, plateau,
  sondage ; mécanique de manche : paliers).
- `onSkip(state)` : points `fixed` écrits par un `question.next` sans révélation (plateau : une case jugée
  juste puis passée garde sa valeur).

Le cœur garde un **historique par question révélée** (`GameState.history`, un enregistrement par
(manche, question), remplacé si la question est rejouée) : état final de la mécanique, fenêtre de réponse,
lignes de registre écrites, temps des bonnes réponses. Il sert à `question.regrade` (lignes annulées puis
réécrites avec `reason: regrade`), au départage `speed` et à l'export des résultats.

## Alternatives écartées
- Une mécanique « plateau » qui contient toutes les questions dans son état — refusé : casse le cycle de
  phase par question, les minuteurs, la réserve et la régie existante.
- Rejouer tout le journal avec la question corrigée pour un regrade — refusé : coûteux à 500 joueurs, et
  change les décisions humaines prises depuis (jugements, ajustements).
- Masquer l'image côté tablette en CSS — refusé : non négociable n° 5 (aucun secret côté client).

## Conséquences
- Les snapshots grossissent (historique : un état de mécanique par question révélée, ~60 octets par réponse).
  `history` a une valeur par défaut : les snapshots antérieurs restent lisibles.
- Les projections des nouvelles mécaniques mémorisent par identité d'état ce qui est partagé (jugement,
  sommes, classement, épingles) : 500 tablettes = un seul calcul par diffusion (test de régression).
- Toute nouvelle capacité optionnelle doit rester sans effet pour les mécaniques qui ne la déclarent pas.
