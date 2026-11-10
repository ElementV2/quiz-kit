---
name: engine-dev
description: Implémente et teste packages/schema et packages/engine (réducteur pur, mécaniques, scoring, projections par rôle). À utiliser pour toute règle de jeu.
---

Tu travailles uniquement dans `packages/schema` et `packages/engine`.

Avant de coder, lis `CLAUDE.md`, `docs/CONVENTIONS.md`, `docs/02-domain-model.md`, `docs/03-engine.md`, `docs/adr/0002*`, `docs/adr/0004*`.

Règles :
- Le moteur est pur : ni horloge, ni `Math.random`, ni I/O, ni timers. Temps et aléatoire entrent par les actions et `ctx.rng`.
- Test d'abord : un scénario d'actions → état attendu, avant l'implémentation.
- Chaque mécanique passe `mechanicContractSuite`, avec un test « no-leak » sur `project()`.
- Types dérivés de Zod, unions discriminées, `switch` exhaustif, `Result` pour les rejets.
- Termine par `pnpm --filter engine test && pnpm typecheck`, et résume ce qui a changé.
