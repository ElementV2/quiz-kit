# ADR-0015 — Manche « Mixte » : chaque question jouée selon son type

- Statut : accepté
- Date : 2026-11-11

## Contexte
Une manche avait une seule mécanique (QCM, réponse libre, sondage…), et chaque mécanique refusait les autres types
de question (« une manche QCM ne peut pas jouer une question sondage »). En live, l'animateur décide question par
question : un sondage, une réponse orale, un QCM dans la même manche. Le blocage arrivait à l'antenne.

## Décision
Une mécanique **routeuse** `mixed` (« Mixte ») : elle ne joue jamais elle-même. Au `question.present`, le moteur
appelle `playedBy(round, question)` (`packages/engine/src/route.ts`), qui demande à `route()` quelle mécanique joue ce
type de réponse (`MIXED_ROUTES` : QCM / vrai-faux → `choice`, sondage → `poll-board`, orale → `buzzer`, libre →
`text-answer`, nombre → `number-answer`, ordre, associations, pin, répartition) et avec quels réglages (dérivés de
`MixedConfig`). `GameState.mechanic.id` est celui de la vraie mécanique : vues, jugement, regrade, mises, rendu,
tablettes et animateur la voient comme une question ordinaire. Les mises et le contrôle de compatibilité du studio
passent aussi par `playedBy`.

Les mécaniques « un seul type de question » ne sont plus proposées pour une nouvelle manche ; le studio propose
« Mixte » (par défaut) puis les formats qui changent la règle de toute la manche : paliers, plateau, buzzer (tout au
buzzer), indices, image dévoilée, vote du chat. Les modèles livrés passent en manches mixtes. Les anciennes parties
gardent leurs types (toujours exécutés par le moteur, toujours listés pour la manche qui les utilise).

## Alternatives écartées
- Une mécanique enveloppe dont l'état contient celui de la mécanique déléguée : toutes les vues, le rendu et les
  apps testent `view.mechanic.mechanic` ; il aurait fallu tout ré-aiguiller. Le routage à la présentation ne change rien en aval.
- Une mécanique choisie par question dans le document : plus de réglages à saisir pour rien, le type de réponse
  suffit à décider.
- Supprimer les mécaniques par type : casserait les journaux et parties existants.

## Conséquences
- Une manche peut mélanger tous les types ; plus de « ne peut pas jouer » sauf formats spéciaux.
- Les mécaniques de manche (paliers, plateau) ne sont jamais routées : leur progression couvre toute la manche.
- Le sondage routé compte ses propres points (`ownPoints`) : la mise propose seulement un multiplicateur.
- Les scènes doivent contenir les zones de chaque type joué (la scène programme par défaut les a toutes).
- Réglages non repris en mixte : le multiplicateur du sondage (utiliser la mise ×2 / ×3 en régie) et « laisser une
  réponse vide » de la répartition (valeur par défaut de la mécanique).
- Le sondage routé (`poll-board`) est un jeu d'équipes : le studio le signale dans une partie solo ou public.
- Les modèles déjà copiés dans une bibliothèque ne sont pas convertis : seules les nouvelles copies sont en mixte.
- Un état « mixed » à l'antenne est invalide (`stateSchema: z.never()`) : un snapshot qui le prétendrait est ignoré.
