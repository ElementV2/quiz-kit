# ADR-0010 — Undo par événement, idempotence durable, temps en heure murale

- Statut : accepté
- Date : 2026-11-10

## Contexte
Le journal est append-only, mais l'undo prévoyait de « marquer » un événement. Les clés d'idempotence n'étaient
pas persistées (doublon possible après crash). Une horloge monotone repart de zéro au redémarrage.

## Décision
- **Undo = un événement** `undo { targetSeq? }`, jamais une mutation du journal. État courant = rejeu de tous les
  événements en ignorant ceux annulés par un `undo` actif (annuler un `undo` = redo).
- `undo` sans cible = dernière action **de la régie** non annulée. Les réponses joueurs ne sont jamais ciblées par défaut.
- Une action postérieure à la cible qui devient invalide au rejeu est **ignorée et signalée** (`skipped` dans le
  résultat du rejeu, visible en régie). Elle reste dans le journal.
- Snapshots : un undo dont la cible est antérieure au dernier snapshot force un rejeu complet depuis l'état initial
  (borné par la taille d'un show). Le champ `history` de `GameState` est supprimé.
- **Idempotence** : la clé est une colonne `UNIQUE` du journal. Une intention déjà journalisée renvoie le même `ack`,
  y compris après redémarrage. Les rejets ne sont pas journalisés (rejouer un rejet redonne un rejet).
- **Temps** : chaque événement porte `at` (heure murale serveur, ms). Le moteur reçoit `ctx = { rng, at, actor, seq }`.
  Pas de `Clock` dans le moteur. Les échéances des timers sont dans l'état, en heure murale ; au démarrage, le serveur
  rejoue puis ré-arme les timers depuis l'état. Une échéance passée pendant la panne déclenche `timer.expired` aussitôt.

## Conséquences
Rejeu déterministe, undo/redo traçables, aucune réponse comptée deux fois.
