# API de contrôle externe (Companion, Stream Deck, OSC, boîtiers buzzers)

Mêmes actions que la régie : chaque commande devient **une** action du moteur, journalisée (acteur
`control` / `api` ou `osc`), donc annulable par la régie et rejouée à l'identique. Source :
`apps/server/src/control/` (`commands.ts`, `osc.ts`, `osc-server.ts`), routes dans `apps/server/src/http/app.ts`.

## Commandes

| Commande | Arguments | Effet |
|---|---|---|
| `next` | — | l'étape suivante, exactement comme la barre Espace de la régie (démarrer, présenter, ouvrir, fermer, révéler, suivante) |
| `open` / `lock` / `reveal` | — | ouvrir / fermer les réponses / révéler |
| `undo` | — | annuler la dernière action régie |
| `timer-add` | secondes (défaut 10, négatif = retirer) | rallonger le chrono en cours |
| `timer-stop` | — | arrêter le chrono |
| `layer-take` / `layer-out` / `layer-toggle` | id de couche (ex. `banner`) | TAKE / OUT d'une couche manuelle |
| `buzz` | n° de siège | buzz pour le joueur assis à ce siège (boîtier buzzers réseau) |
| `judge` | `1` bonne / `0` mauvaise | juge le joueur qui a la main (buzzer, plateau) |
| `hint` | — | indice suivant (`hints`) ou case suivante (`reveal-image`) |
| `joker` | `fifty` ou `audience` | joker des paliers |
| `stop` | — | le candidat des paliers s'arrête |

Deux appuis dans le même instant sont évalués sur le même état : le second est refusé, jamais de double
étape par accident. En HTTP, un en-tête `Idempotency-Key` (8 à 64 caractères `[0-9A-Za-z_-]`) rend une requête
rejouée sans effet (Companion qui relance, double clic) : à mettre sur `undo` en particulier.

## HTTP

- `POST http://<serveur>:7300/api/v1/<commande>` avec le **jeton régie** : en-tête
  `Authorization: Bearer <jeton>` (ou `?t=<jeton>`). Arguments : corps JSON `{"args": [3]}` ou `?arg=3`.
- Réponse **toujours 200** quand le jeton est bon, `{ "ok": true, "did": "Révéler", "seq": 42 }` ou
  `{ "ok": false, "code": "wrong-phase", "reason": "…" }` — Companion met la connexion en erreur sur tout
  code hors 2xx. `401` jeton invalide, `404` commande inconnue.
- `GET /api/v1/state` : `{ phase, round, question {index, count, text}, timerRemainingMs, hand, next,
  hostDrives, top [{rank, name, total}] }` — pour les variables / retours d'état des touches.

Le jeton régie se copie depuis l'accueil (`/`, bouton « Lien » de la Régie : la partie après `t=`).

## Bitfocus Companion — pas à pas

Module **Generic: HTTP Requests** (`generic-http`, vérifié sur github.com/bitfocus/companion-module-generic-http) :
1. Connexions → ajouter « Generic: HTTP Requests », **Base URL** = `http://<IP du serveur>:7300/api/v1/`.
2. Sur une touche : action **POST**, URL = `next` (ou `reveal`, `layer-toggle?arg=banner`, `buzz?arg=3`…),
   **Header** = `{"Authorization": "Bearer <jeton régie>"}`, Content-Type `application/json`.
3. Retour d'état : action GET `state` dans un trigger, « JSON Response Data Variable » → variables
   (ex. afficher `next` sur la touche Espace).

Module **Generic: OSC** (`generic-osc`) : voir ci-dessous, en **UDP** (le framing TCP du module n'est pas vérifié).

## OSC (UDP)

Désactivé par défaut (UDP = aucune authentification). Activer : `QUIZ_OSC_PORT=7301` **et**
`QUIZ_OSC_ALLOW=192.168.1.30,192.168.1.31` (obligatoire : sans liste, l'OSC ne démarre pas). `undo` n'existe pas en
OSC (un paquet dupliqué annulerait deux fois) : passer par la régie ou HTTP avec `Idempotency-Key`. Au plus
16 messages par paquet et 30 par seconde et par émetteur. Le filtre par IP se contourne par usurpation
d'adresse : réseau plateau isolé uniquement. Adresse `/quiz/<commande>`, arguments
OSC (`i`, `f`, `s`, `T`/`F`) : `/quiz/next`, `/quiz/buzz ,i 3`, `/quiz/layer-take ,s banner`, `/quiz/judge ,i 1`.
Les bundles sont acceptés (exécutés immédiatement, timetag ignoré). Codec : OSC 1.0
(opensoundcontrol.stanford.edu/spec-1_0.html).

## Buzzers physiques

- **Boîtier réseau** (Arduino / ESP32 / boîtier du commerce qui parle HTTP ou OSC) : `buzz` avec le n° de siège.
  L'ordre d'arrivée au serveur = l'ordre du journal = qui a la main (doc 03).
- **Buzzers USB** vus comme un clavier (HID) : la page « Buzzers clavier » de la régie associe chaque touche
  à un siège (voir doc 08). Latence d'un buzzer USB → navigateur → serveur : à mesurer en répétition.
