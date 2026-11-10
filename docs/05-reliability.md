# 05 — Fiabilité live

Cible : 50 tablettes en usage courant, **dimensionner pour 500** terminaux par serveur, 10 000+ votes chat.
Zéro réponse perdue, zéro fuite, aucune panne qui coupe l'antenne.

## Matrice des pannes

| Panne | Protection | Test qui le prouve |
|---|---|---|
| Tablette perd le Wi-Fi | Reconnexion + file locale + idempotence + resynchro | `chaos:wifi-drop` |
| Tablette en veille | Wake Lock API + mode kiosque (Accès guidé iOS / épinglage Android) | check-list pré-show |
| Sortie OBS/vMix plante ou recharge | Snapshot au welcome, état exact en < 1 s | `e2e:output-reload` |
| Crash du serveur | Journal SQLite écrit avant diffusion, superviseur relance, reprise par rejeu | `chaos:kill-server` |
| Machine show HS | Phase 4 : hot standby qui suit le journal, bascule manuelle | `chaos:failover` |
| Internet coupé | Mode Show 100 % LAN | test réseau isolé |
| Média lourd | Préchargement + cache Service Worker, check-list rouge si incomplet | `e2e:preload` |
| Erreur régie | Undo, overrides, confirmation des actions irréversibles | tests moteur |
| Spam chat | 1 réponse / compte / question, rate limit, filtre comptes récents | `load:chat` |

## Boucle de jeu

- File sérialisée, une action à la fois. Aucune I/O lente dans la boucle hormis l'append journal.
- Diffusion découplée : si un client est lent (buffer plein), il est passé en `snapshot au prochain tick`
  plutôt que de ralentir les autres.
- Snapshot persisté à chaque `question.present` pour borner le temps de rejeu.

## Réseau plateau

Machine show en filaire, SSID dédié au jeu en 5 GHz, plusieurs AP au-delà de quelques dizaines de tablettes,
IP fixe ou réservation DHCP pour la machine show, mDNS en secours. Débit négligeable : c'est la stabilité
et la charge par AP qui comptent.

## Check-list « Prêt pour l'antenne » (écran régie)

Médias préchargés sur chaque client ✓ · tablettes connectées et assignées ✓ · horloges synchronisées ✓ ·
sorties ouvertes ✓ · journal actif et disque OK ✓ · chat connecté (si utilisé) ✓.

## Critères de sortie de chaque phase

- `pnpm load` : 500 clients simulés sur une partie complète, 0 réponse perdue, latence de diffusion stable
  (seuils à fixer après le premier bench).
- Chaos : couper le Wi-Fi, tuer le serveur, recharger une sortie en pleine question → partie identique à la fin.
