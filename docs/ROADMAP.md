# Roadmap

Règle : une phase n'est terminée que quand ses critères de sortie passent. Cocher les cases au fil de l'eau.

## Phase 0 — Socle (rien ne casse)

- [ ] Monorepo pnpm + Turborepo, TS strict, lint (règles d'import entre paquets), Vitest, CI locale (`pnpm check`)
- [ ] `schema` : Question, AnswerSpec (single, boolean, poll, oral), Format, Round, Session, Participant, Team, ScoreEntry, Event + `schemaVersion`
- [ ] `engine` : `reduce`, `project`, `replay`, registre de mécaniques, `mechanicContractSuite`, Rng seedé
- [ ] Mécanique `choice` (QCM 2 à 6 options, vrai/faux) + scoring de base + registre de score + undo
- [ ] `protocol` : hello/welcome/patch/snapshot/intent/ack/ping, séquences, idempotence
- [ ] `server` : Fastify + ws, file d'actions sérialisée, EventStore SQLite (WAL), snapshots, timers serveur, jetons par rôle
- [ ] `protocol/client` : reconnexion backoff, file d'intentions persistée, resynchro
- [ ] Bot client + script k6

**Sortie** : 500 clients simulés, partie complète, 0 réponse perdue ; chaos (kill serveur, coupure réseau) → état final identique.

## Phase 1 — Un show jouable

- [ ] `renderer` : SceneRenderer, zones question / answer / answer-list / timer / score / leaderboard, états, couches TAKE/OUT
- [ ] `output` : sortie 1920×1080 transparente, reprise par snapshot
- [ ] `control` : run-down, actions contextuelles, couches, scores éditables, undo, raccourcis
- [ ] `host` : bonne réponse, notes, valider / refuser
- [ ] `player` : PWA `/seat/<n>` et `/play/<code>`, Wake Lock, cache médias, « Réponse enregistrée » après ack
- [ ] Mécaniques `poll-board` (sondage à slots, 3 erreurs, vol) et `buzzer` (priorité, blocage)
- [ ] Joueurs / équipes / sièges : création, import CSV, statuts, échange de tablette
- [ ] Import CSV de questions
- [ ] Templates codés : QCM à paliers (`ladder`), sondage à slots, buzzer culture G
- [ ] Check-list pré-antenne

**Sortie** : répétition réelle avec 50 tablettes et une sortie dans OBS, sans incident.

## Phase 2 — Studio et habillage

- [ ] Mode Contenu (tableur), mode Scènes (canvas, zones, bindings, inspecteur d'états, simulation)
- [ ] Thèmes (tokens, matériaux, motion, sons) + génération depuis 2 couleurs + logo
- [ ] Moments + couche PixiJS + niveaux de qualité — **bench OBS / vMix**
- [ ] Import de design reçu (calque de référence, tracé de zones, découpe, 9-slice, états dérivés)
- [ ] Export gabarit (PNG/SVG + fiche PDF/CSV) + réimport par nommage
- [ ] Médias : stockage par hash, transcodage ffmpeg, contrôles à l'import
- [ ] Export / import de jeu `.quiz`

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
