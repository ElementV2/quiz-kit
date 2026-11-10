# ADR-0003 — Serveur autoritaire, file sérialisée, journal SQLite

- Statut : accepté
- Date : 2026-11-10

## Contexte
50 à 500 terminaux, une régie, des corrections manuelles, et l'obligation de reprendre après un crash.

## Décision
Un process serveur unique détient l'état. Les intentions entrent dans une file traitée une par une.
Chaque action acceptée est écrite dans un journal SQLite (WAL) **avant** diffusion. Snapshots à chaque
`question.present`. Undo = rejeu sans l'action annulée (marquée `voided`).

## Alternatives écartées
- État partagé en mémoire distribuée / CRDT : inutile sur un plateau avec une autorité claire.
- Postgres : un serveur de plus à faire tourner en tournage.

## Conséquences
Reprise exacte après crash, undo fiable, replay pour contestations. Le niveau `synchronous` de SQLite reste
à valider (voir OPEN-QUESTIONS).
