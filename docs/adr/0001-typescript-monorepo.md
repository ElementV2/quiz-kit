# ADR-0001 — Monorepo TypeScript, moteur partagé

- Statut : accepté
- Date : 2026-11-10

## Contexte
Le même code de règles doit tourner sur le serveur (autorité), dans le studio (simulation d'états,
mode Répétition) et dans les tests. Charge visée : centaines de clients par serveur.

## Décision
Monorepo pnpm + Turborepo, TypeScript strict partout, `packages/engine` partagé tel quel.

## Alternatives écartées
- Serveur Rust + moteur dupliqué en TS : deux implémentations des règles à garder identiques.
- Moteur Rust compilé en WASM partout : complexité de build et de debug sans gain mesuré à cette charge.

## Conséquences
Une seule source de vérité des règles. Rust reste possible pour des modules isolés (NDI).
