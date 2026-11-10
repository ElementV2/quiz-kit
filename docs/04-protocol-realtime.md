# 04 — Protocole temps réel (`packages/protocol`)

## Transport

Un WebSocket par client (`/ws`). Messages JSON validés par Zod des deux côtés, taille max 16 ko (à ajuster
au bench), rate limit par connexion. Protocole versionné (`v` dans le `hello`). Le paquet ne dépend que de
`schema` (ADR-0007) et ne contient aucune API Node (il est aussi bundlé pour k6 et les navigateurs).

## Poignée de main (ADR-0009)

```
client → { t:'hello', v, token, clientId }
server → { t:'welcome', viewer, serverTime, viewSeq, view }     // toujours un snapshot complet
```

`token` = jeton signé du rôle (voir `10-security.md`). `clientId` stable par appareil (stocké localement).
Pas de reprise incrémentale : chaque reconnexion repart d'un snapshot.

## Messages serveur → client

- `{ t:'patch', viewSeq, ops }` : diff de la vue projetée, sous-ensemble de RFC 6902 (`add` / `remove` / `replace`).
- `{ t:'snapshot', viewSeq, view }` : vue complète (sur `resync`, sur patch plus gros que la vue, client lent).
- `{ t:'ack', key, ok, reason?, eventSeq? }` : accusé d'une intention, envoyé **après** le commit du journal.
- `{ t:'ping', serverTime }` : heartbeat + synchro d'horloge.
- `{ t:'preload', hashes[] }` : médias à précharger (phase 1).
- `{ t:'error', code, message }` : erreur de protocole (jeton invalide, version, message mal formé) avant fermeture.

`viewSeq` est **par connexion** : chaque `patch` / `snapshot` vaut le précédent + 1. Un client qui voit un trou
envoie `resync`. `eventSeq` (journal) n'est exposé qu'à titre d'information dans l'`ack`.

## Messages client → serveur

- `{ t:'intent', key, action }` : `key` = clé d'idempotence (UUID) ; renvoyée tant que pas d'`ack`.
- `{ t:'pong', clientTime, serverTime }`.
- `{ t:'resync' }`.

La clé d'idempotence est persistée dans le journal (colonne `UNIQUE`, ADR-0010) : une intention rejouée,
même après redémarrage du serveur, renvoie le même `ack` sans réappliquer.

## Horloge et équité

- Horodatage de référence = **réception serveur**, heure murale en ms (l'ordre est donné par `eventSeq`).
- Synchro d'horloge façon NTP via ping/pong : offset et RTT par client, glissants.
- `question.open` diffuse `startsAt` (heure serveur) : les tablettes affichent le chrono à partir de là.
- Buzzers : ordre de réception serveur ; compensation par RTT seulement si l'écart de latence entre
  clients dépasse un seuil configurable (désactivée par défaut sur LAN, à mesurer).
- Chat : fenêtre de réponse décalée du retard de flux (réglage `streamDelayMs`, mesuré en répétition).

## Reconnexion côté client

Backoff exponentiel avec jitter, plafond court (2 s par défaut) pour revenir vite.
File locale des intentions non acquittées (port de stockage : IndexedDB sur `player`, mémoire en test),
renvoyée au retour. L'UI joueur n'affiche « Réponse enregistrée » qu'après l'`ack`.

## Canaux non-WebSocket

Tous convertis en actions identiques côté serveur (`server/inputs/*`) :
buzzer USB HID / boîtier réseau, Twitch EventSub, YouTube Live chat, API HTTP/OSC de contrôle.
