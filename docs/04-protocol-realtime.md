# 04 — Protocole temps réel (`packages/protocol`)

## Transport

Un WebSocket par client. Messages JSON validés par Zod des deux côtés, taille max fixée (ex. 16 ko,
à ajuster), rate limit par appareil. Protocole versionné (`v` dans le `hello`).

## Poignée de main

```
client → { t:'hello', v, token, lastSeq? , clientId }
server → { t:'welcome', viewer, serverTime, seq, snapshot }     // ou 'resume' + événements manqués
```

`token` = jeton signé du rôle (voir `10-security.md`). `clientId` stable par appareil (stocké localement).

## Messages serveur → client

- `{ t:'patch', seq, ops }` : diff de la vue projetée (JSON Patch ou format maison, à décider par ADR).
- `{ t:'snapshot', seq, view }` : vue complète (au welcome, sur trou de séquence, sur demande).
- `{ t:'ack', key, ok, reason? }` : accusé d'une intention.
- `{ t:'ping', serverTime }` : heartbeat + synchro d'horloge.
- `{ t:'preload', hashes[] }` : médias à précharger.

Chaque `patch` porte `seq` = seq précédent + 1. Un client qui voit un trou demande un `snapshot`.

## Messages client → serveur

- `{ t:'intent', key, action }` : `key` = clé d'idempotence (UUID) ; renvoyée tant que pas d'`ack`.
- `{ t:'pong', clientTime, serverTime }`.
- `{ t:'resync' }`.

Le serveur garde les clés vues par session : une intention rejouée renvoie le même `ack` sans réappliquer.

## Horloge et équité

- Horodatage de référence = **réception serveur** sur horloge monotone.
- Synchro d'horloge façon NTP via ping/pong : offset et RTT par client, glissants.
- `question.open` diffuse `startsAt` (heure serveur) : les tablettes affichent le chrono à partir de là.
- Buzzers : ordre de réception serveur ; compensation par RTT seulement si l'écart de latence entre
  clients dépasse un seuil configurable (désactivée par défaut sur LAN, à mesurer).
- Chat : fenêtre de réponse décalée du retard de flux (réglage `streamDelayMs`, mesuré en répétition).

## Reconnexion côté client

Backoff exponentiel avec jitter, plafond court (quelques secondes) pour revenir vite.
File locale des intentions non acquittées (persistée en IndexedDB sur `player`), renvoyée au retour.
L'UI joueur n'affiche « Réponse enregistrée » qu'après l'`ack`.

## Canaux non-WebSocket

Tous convertis en actions identiques côté serveur (`server/inputs/*`) :
buzzer USB HID / boîtier réseau, Twitch EventSub, YouTube Live chat, API HTTP/OSC de contrôle.
