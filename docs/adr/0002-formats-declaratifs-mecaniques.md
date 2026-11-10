# ADR-0002 — Formats déclaratifs + mécaniques enregistrées

- Statut : accepté
- Date : 2026-11-10

## Contexte
L'objectif est de pouvoir créer « tout type de quiz ». Un langage de règles libre deviendrait un langage de
programmation : impossible à tester exhaustivement, risqué en live.

## Décision
Un `Format` est un document JSON qui **assemble** des mécaniques codées en TS et enregistrées
(`registerMechanic`), chacune avec son schéma de config. L'utilisateur paramètre, il n'écrit pas de code.
Nouvelle mécanique = nouveau module TS qui passe `mechanicContractSuite`.

## Alternatives écartées
- DSL / scripts utilisateur (JS sandboxé, Lua) : surface de bugs et de sécurité trop grande pour du live.
- Formats codés en dur : pas d'assemblage possible.

## Conséquences
Couverture large avec une douzaine de mécaniques. Les formats vraiment exotiques demandent une nouvelle
mécanique (du code), ce qui est voulu.
