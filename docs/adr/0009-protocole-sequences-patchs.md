# ADR-0009 — Protocole : séquence par connexion, snapshot à la reconnexion, patch RFC 6902

- Statut : accepté
- Date : 2026-11-10

## Contexte
Le doc 04 prévoyait une reprise par « événements manqués », or un client ne connaît que sa vue projetée,
jamais les événements. Le `seq` était ambigu (journal ou vue).

## Décision
- Deux compteurs distincts : `eventSeq` (journal, côté serveur) et `viewSeq` (par connexion, +1 à chaque
  `patch` / `snapshot`). Le client vérifie la continuité de `viewSeq`.
- À chaque `hello` (y compris reconnexion), le serveur répond `welcome` avec un **snapshot** complet de la vue.
  Pas de reprise incrémentale : les vues sont petites et c'est le chemin le plus simple et le plus testé.
- Ensuite : `patch` = opérations **sous-ensemble de RFC 6902** (`add`, `remove`, `replace`, chemins JSON Pointer
  RFC 6901), calculées et appliquées par du code maison testé (aucune lib). Si le patch est plus gros que la vue,
  le serveur envoie un `snapshot`.
- Trou de `viewSeq` côté client → `resync` → snapshot.
- Client lent (buffer d'émission au-dessus d'un seuil) : on n'empile plus de patchs, il reçoit un snapshot quand
  son buffer est revenu sous le seuil.

## Alternatives écartées
- Reprise par patchs bufferisés par client : mémoire et cas limites, pour un gain nul sur LAN.
- Vue complète à chaque changement : simple, mais 500 × taille de vue à chaque action.

## Conséquences
Recharger une sortie OBS = un `welcome` = état exact immédiat.
