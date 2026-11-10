# 08 — Régie, animateur, sorties (`apps/control`, `apps/host`, `apps/output`)

## Régie (`/control/<show>`)

- Gauche : run-down (manches, questions, statut), saut direct, questions de réserve.
- Centre : aperçu programme + aperçu étape suivante (preview / program).
- Droite : actions contextuelles fournies par `actionsFor()` (révéler slot 3, valider, refuser, vol…),
  couches TAKE/OUT, jokers, **Undo**.
- Bas : participants (connecté, a répondu, latence, siège), alertes.
- Tout au clavier, raccourcis configurables, touche unique « étape suivante » (espace).
- Confirmation sur les actions irréversibles (fin de partie, élimination).
- Une seule régie **maître** ; autres postes en lecture ou en rôle limité (scoreur).

## Animateur (`/host/<show>`)

Question en cours, bonne réponse, fiche notes, prochaine question, valider / refuser si le format le permet.

## Sorties (`/out/<show>/<scene>`)

1920×1080, fond transparent, lecture seule, jeton de sortie. Programme, mur LED, lower-third seul,
leaderboard seul, retour plateau. Phase 5 : NDI natif et pilotage des titres vMix via son API.
À vérifier : transparence de l'input Web Browser de vMix (voir `OPEN-QUESTIONS.md`).

## API de contrôle externe

HTTP + WebSocket + OSC sur le serveur, mêmes actions que la régie, même jeton.
Cible : Bitfocus Companion (Stream Deck), MIDI, scripts. Retour d'état pour les couleurs des touches.
Documenter chaque endpoint / adresse OSC dans `docs/api/control.md` au fur et à mesure.

## Check-list pré-antenne

Voir `05-reliability.md`.
