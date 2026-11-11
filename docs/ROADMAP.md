# Roadmap

Règle : une phase n'est terminée que quand ses critères de sortie passent. Cocher les cases au fil de l'eau.

## Phase 0 — Socle (rien ne casse)

- [x] Cadrage : relecture du kit, ADR 0007 → 0012, docs corrigés, points ouverts vérifiés
- [x] Monorepo pnpm + Turborepo, TS strict, lint (règles d'import entre paquets), Vitest, CI locale (`pnpm check`)
- [x] `schema` : Question, AnswerSpec (single, multi, boolean, poll, oral), Format, Round, Session, Participant, Team, ScoreEntry, Event, Actions, Vues + `schemaVersion`
- [x] `engine` : `reduce`, `project`, `replay`, registre de mécaniques, `mechanicContractSuite`, Rng seedé
- [x] Mécanique `choice` (QCM 2 à 6 options, vrai/faux, multi) + scoring de base + registre de score + undo
- [x] `protocol` : hello/welcome/patch/snapshot/intent/ack/ping, séquences, idempotence
- [x] `server` : Fastify + ws, file d'actions sérialisée, EventStore SQLite (WAL + FULL), snapshots, timers serveur, jetons par rôle
- [x] `protocol/client` : reconnexion backoff, file d'intentions persistée, resynchro
- [x] Bot client + chaos (`pnpm chaos`) + script k6 (`pnpm load`)

**Sortie** : 500 clients simulés, partie complète, 0 réponse perdue ; chaos (kill serveur, coupure réseau) → état final identique.

**Mesuré le 2026-11-11** (PC de dev Windows 11, serveur + 500 tablettes k6 sur la même machine, Node 26.13, k6 2.3) :
- `pnpm load` : 500 tablettes × 10 questions → 5 000 réponses acquittées, 5 000 au journal, **0 perdue** ;
  ack d'une réponse médiane ≈ 15 ms, p95 ≈ 30 ms ; diffusion régie → sortie médiane ≈ 30 ms, p95 ≈ 60 ms
  (dont 25 ms de regroupement volontaire) ; connexion p95 ≈ 120 ms.
- `pnpm chaos` : 50 bots, kill -9 du serveur en pleine question, coupure réseau générale, rechargement de la sortie
  → 500 / 500 réponses, 0 perdue, 0 doublon, état final de la sortie = rejeu du journal. ✓

## Phase 1 — Un show jouable

- [x] `renderer` : SceneRenderer, zones question / answer-list / timer / leaderboard / média / sondage / buzzer / paliers, états, couches TAKE/OUT
- [x] `output` : sortie 1920×1080 transparente, reprise par snapshot
- [x] `control` : run-down, actions contextuelles, couches, scores éditables, undo, raccourcis
- [x] `host` : bonne réponse, notes, valider / refuser (buzzer, sondage)
- [x] `player` : `/seat/<n>` et `/play` (code), écran allumé sans HTTPS, préchargement médias, « Réponse enregistrée » après ack
- [x] HTTPS LAN tranché (ADR-0012) : HTTP simple, aucune install sur les tablettes louées — prérequis de `player` (Wake Lock, Service Worker)
- [x] Médias minimum : stockage par hash + `preload` (prérequis du cache médias de `player`)
- [x] Mécaniques `poll-board` (sondage à slots, 3 erreurs, vol) et `buzzer` (priorité, blocage)
- [x] Mécanique `ladder` + jokers 50:50 / sondage public (prérequis du template QCM à paliers)
- [x] Joueurs / équipes / sièges : création, import CSV, statuts, échange de tablette (changement de siège)
- [x] Import CSV de questions (régie : coller / fichier → nouvelle partie à chaud)
- [x] Templates codés : QCM rapide, QCM à paliers (`ladder`), sondage à slots, buzzer culture G (bibliothèque)
- [x] Check-list pré-antenne

**Sortie** : répétition réelle avec 50 tablettes et une sortie dans OBS, sans incident. — **à faire par l'équipe** (tout est prêt côté logiciel : e2e régie / sortie / tablettes / buzzer / sondage / paliers verts ; charge 500 tablettes et chaos verts).

## Phase 2 — Studio et habillage

- [x] Mode Contenu (tableur), mode Scènes (canvas, zones, bindings, inspecteur d'états, simulation)
- [x] Thèmes (tokens, motion) + génération depuis 2 couleurs (contraste WCAG) — matériaux, sons et logo : à compléter
- [x] Moments + couche PixiJS + niveaux de qualité (`?fx=full|light|off`, défaut `light`) — **bench OBS / vMix à faire par l'équipe** (`?bench=1` affiche les fps)
- [x] Import de design reçu (calque de référence, tracé de zones, découpe, 9-slice, états dérivés, PSD à calques nommés, pipette, alignement / répartition / duplication)
- [x] Export gabarit (PNG/SVG/PSD à calques + fiche CSV/PDF) + réimport par nommage
- [x] Médias : stockage par hash, transcodage ffmpeg, contrôles à l'import
- [x] Export / import de jeu `.quiz` (zip : game.json + médias adressés par hash, vérifiés à l'import)

## Phase 3 — Formats libres

- [ ] Mode Format (manches en cartes, blocs de règles, jokers)
- [ ] Mécaniques `text-answer`, `number-answer`, `order`, `pairs`, `pin`, `allocation`, `board`, `hints`, `reveal-image`
- [ ] Questions de réserve, `question.regrade`, départage
- [ ] Mode Répétition avec bots
- [ ] Export des résultats, replay

## Phase 4 — Diffusion élargie

- [ ] Chat Twitch (EventSub) + YouTube, `crowd-vote`, `streamDelayMs`, anti-spam
- [ ] API de contrôle HTTP / WS / OSC documentée + Companion
- [ ] Buzzers physiques (USB HID, boîtier réseau)
- [ ] Packaging Tauri + serveur compilé
- [ ] Hot standby + bascule

## Phase 5 — Broadcast avancé

- [ ] Sortie NDI native (module Rust à étudier)
- [ ] Pilotage des titres vMix par API
- [ ] Éditeur de machine d'états en nodes
