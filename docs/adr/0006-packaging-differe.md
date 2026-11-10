# ADR-0006 — Packaging desktop différé à la phase 4

- Statut : accepté
- Date : 2026-11-10

## Contexte
Tauri + serveur Node compilé en sidecar ajoute du build natif (better-sqlite3) avant même d'avoir un show.

## Décision
Phases 0 à 3 : `pnpm start` sur la machine show, apps servies par le serveur et ouvertes dans un navigateur.
Phase 4 : lanceur Tauri 2 qui démarre et supervise le serveur compilé (Node SEA ou `bun build --compile`, à trancher).

## Conséquences
Démarrage plus rapide du projet. Le serveur doit dès le départ tourner comme un process autonome, sans
dépendre d'un shell de dev.
