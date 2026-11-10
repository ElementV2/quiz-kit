# ADR-0004 — Vues projetées par rôle

- Statut : accepté
- Date : 2026-11-10

## Contexte
Anti-triche : la bonne réponse ne doit jamais atteindre un navigateur joueur avant la révélation.

## Décision
`engine.project(state, viewer)` calcule une vue par rôle côté serveur. Les clients ne reçoivent que leur vue.
Chaque mécanique a un test « no-leak » (propriété : pour tout état non révélé, la vue `player` / `output`
ne contient aucune donnée de `correct`, `value` de sondage non révélée, ni notes animateur).

## Conséquences
Les fronts ne contiennent aucune règle. Coût CPU d'une projection par client : à mesurer au bench, et
mutualiser les vues identiques (tous les `output:program`, tous les `player` d'une même phase).
