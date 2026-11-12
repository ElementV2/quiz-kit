# 08 — Régie, animateur, sorties (`apps/control`, `apps/host`, `apps/output`)

## Accueil (`/`)

L'adresse du serveur ouverte dans un navigateur (`http://<IP>:7300/`) donne l'accueil : « Jouer » pour les
joueurs (code de la partie), et pour l'équipe un **code équipe** (8 caractères) qui déverrouille tous les postes
(Régie, Animateur, Studio, Régie lecture seule) en un clic, les liens des sorties OBS / vMix à copier, le code
de la partie avec son QR code pour les tablettes, et les sièges fixes (lien + QR). Personne ne recopie de
liens à rallonge. Sur le PC du serveur lui-même (`localhost`), l'accès est direct et le code équipe y est
affiché pour être donné aux autres postes ; il est aussi dans `links.txt`. `QUIZ_STAFF_CODE` le fixe, sinon il
est tiré une fois et gardé dans la base du journal. Les liens copiés depuis `localhost` utilisent l'IP du réseau
plateau (jamais `localhost`). Anti-force brute : 10 essais par minute et par IP, comme `/api/join`.

## Régie (`/control/<show>`)

- Gauche : run-down (manches, questions, statut), saut direct, questions de réserve.
- Centre : aperçu programme + aperçu étape suivante (preview / program).
- Droite : actions contextuelles fournies par `actionsFor()` (révéler slot 3, valider, refuser, vol…),
  couches TAKE/OUT, jokers, **Undo**.
- Bas : participants (connecté, a répondu, latence, siège), alertes.
- Tout au clavier, raccourcis configurables, touche unique « étape suivante » (espace).
- Confirmation sur les actions irréversibles (fin de partie, élimination).
- Une seule régie **maître** ; autres postes en lecture seule.

## Animateur (`/host/<show>`)

Question en cours, bonne réponse, fiche notes, prochaine question, valider / refuser si le format le permet.

## Sorties (`/out/<show>/<scene>`)

1920×1080, fond transparent, lecture seule, jeton de sortie. Programme, mur LED, lower-third seul,
leaderboard seul, retour plateau. Phase 5 : NDI natif et pilotage des titres vMix via son API.
À vérifier : transparence de l'input Web Browser de vMix (voir `OPEN-QUESTIONS.md`).

## API de contrôle externe

HTTP + OSC sur le serveur, mêmes actions que la régie, même jeton.
Cible : Bitfocus Companion (Stream Deck), MIDI, scripts. Retour d'état pour les couleurs des touches.
**Implémenté** : `docs/api/control.md` (commandes, HTTP `/api/v1/<commande>` + `/api/v1/state`, OSC UDP
`/quiz/<commande>`, pas-à-pas Companion, buzzers physiques).

## Check-list pré-antenne

Voir `05-reliability.md`.

## Lancer / relancer une partie (onglet « Parties »)

Par défaut, les joueurs de la partie en cours **suivent** dans la nouvelle partie : mêmes identifiants (le jeton
`/play` d'un téléphone porte l'identifiant du joueur, il reste valable), mêmes sièges, mêmes équipes (celles que la
régie a créées), même code partie ; les scores repartent de zéro. Les bots de répétition ne suivent pas.
Au-delà du maximum de joueurs de la nouvelle partie, les derniers ne sont pas repris (le message le dit).
Les remplaçants gardent ce statut ; les éliminés repartent en jeu. Le code
partie restant le même, un joueur exclu peut revenir avec : décocher la case pour obtenir un nouveau code.
Décocher « Garder les joueurs actuels » repart de zéro (`POST /api/games/:id/launch?players=new`,
`/api/session` `{ keepPlayers: false }`). Les reprises sont journalisées comme des `player.add` / `team.add` de la
nouvelle session, avant que les écrans ne la reçoivent.
