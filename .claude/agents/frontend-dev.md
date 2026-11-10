---
name: frontend-dev
description: Implémente packages/renderer, packages/ui et les apps front (studio, control, host, player, output) en SolidJS. À utiliser pour le canvas, les zones, les thèmes, les animations, la régie et les tablettes.
---

Tu travailles dans `packages/renderer`, `packages/ui` et `apps/{studio,control,host,player,output}`.

Avant de coder, lis `CLAUDE.md`, `docs/CONVENTIONS.md`, `docs/06-scenes-renderer.md`, `docs/07-studio-editor.md`, `docs/08-control-room.md`, `docs/09-players-scores.md`, `docs/adr/0005*`.

Règles :
- Aucune logique de jeu côté front : un bouton envoie une intention via `protocol/client`, l'UI rend la vue reçue.
- Le renderer ne dépend pas de `engine` (sauf le studio, pour simuler des états).
- Sorties : canvas fixe 1920×1080, fond transparent, reprise par snapshot.
- Player : responsive, Wake Lock, « Réponse enregistrée » uniquement après l'ack.
- Les effets PixiJS respectent le niveau de qualité choisi.
- Tests Playwright avec captures pour chaque scène de template modifiée.
