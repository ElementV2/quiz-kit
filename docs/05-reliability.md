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
| Machine show HS | Hot standby qui suit le journal, bascule manuelle (implémenté, voir plus bas) | `standby.test.ts` |
| Internet coupé | Mode Show 100 % LAN | test réseau isolé |
| Média lourd | Préchargement + cache Service Worker, check-list rouge si incomplet | `e2e:preload` |
| Erreur régie | Undo (événement, ADR-0010), overrides, confirmation des actions irréversibles | tests moteur |
| Spam chat | 1 réponse / compte / question, rate limit, filtre comptes récents | `load:chat` |

## Serveur de secours (hot standby) — implémenté

Deux PC show sur le réseau plateau. Sur le **secours** : copier `secret.key` du principal (tous les liens et
jetons marchent alors sur les deux), puis démarrer avec
`QUIZ_STANDBY_OF=http://<IP du principal>:7300` et `QUIZ_STANDBY_TOKEN=<jeton régie du principal>`.
Le secours lit le journal du principal toutes les 500 ms (`/api/journal`, paginé), l'écrit dans son propre
journal et le rejoue : même état exact, quelques centaines de ms derrière ; il suit les changements de partie et
copie les médias manquants. Tant qu'il n'est pas promu : toute action est refusée, aucun chrono n'est armé,
aucune partie ne peut y être lancée. Régie du secours : un bandeau sous l'en-tête donne l'état de la copie (retard en
actions, dernier contact, médias manquants, erreur) et le bouton **« Basculer »** (confirmation ; API :
`GET /api/standby`, `POST /api/standby/promote`). Sur le serveur principal, rien ne s'affiche.

Bascule **manuelle**, jamais automatique : une coupure du seul lien entre les deux PC laisserait sinon deux
serveurs décider en même temps (split brain). Procédure : constater la panne du principal (écran régie
« déconnecté », `lag` qui ne bouge plus), cliquer « Basculer » sur la régie du secours, puis faire pointer les
écrans sur le secours : IP de secours dans OBS / vMix (ou nom DNS / IP virtuelle qui suit le serveur actif), les
tablettes rouvrent l'accueil du secours. Ne jamais redémarrer l'ancien principal sans `QUIZ_STANDBY_OF` vers
le nouveau.

Garde-fous : la bascule est refusée si le principal a répondu il y a moins de 8 s (forcer = case « le principal
est bien arrêté ») ; le secours cesse de suivre et l'affiche (`diverged`) si les deux serveurs n'ont pas la même
version, si son journal a bifurqué de celui du principal, ou si une action du principal y est refusée — ne pas
basculer sur un secours en divergence. Les médias manquants sont copiés en tâche de fond (`mediaMissing` dans
l'état : attendre 0 avant le show). Seul le serveur actif pilote vMix. **Horloges** : les chronos sont en heure
murale ; synchroniser les deux PC (NTP / heure Windows) avant le show, sinon un chrono repris après bascule part
trop tôt ou trop tard. Code : `apps/server/src/standby.ts`, test `standby.test.ts` (miroir, refus, changement de partie,
bascule).

## Boucle de jeu

- File sérialisée, une action à la fois. Aucune I/O lente dans la boucle hormis l'append journal (et le snapshot
  à chaque `question.present`, un fsync de plus par question).
- **Group commit** (ADR-0008) : les intentions reçues dans le même tour de boucle sont décidées une par une puis
  journalisées en une transaction (un fsync), acquittées après le commit, diffusées une fois.
- Diffusion mutualisée par type de vue (une projection + un diff + une sérialisation), regroupée toutes les 25 ms.
  Les vues joueur portent le top 10 du classement et leur rang, pas le compteur de réponses en direct
  (sinon chaque réponse ferait recalculer les 500 vues : O(n²)).
- Rate limit par connexion (tablette 20 msg/s, rafale 40 ; régie 300 msg/s, rafale 600) ; une intention freinée
  reçoit un ack `rate-limited` et le client la ré-émet : rien n'est perdu.
- `pnpm start` = superviseur qui relance le serveur s'il s'arrête (état repris du journal).
- Diffusion découplée : si un client est lent (buffer plein), il est passé en `snapshot au prochain tick`
  plutôt que de ralentir les autres.
- Snapshot persisté à chaque `question.present` pour borner le temps de rejeu (sauf undo antérieur au snapshot : rejeu complet, ADR-0010).

## Réseau plateau

Machine show en filaire, SSID dédié au jeu en 5 GHz, plusieurs AP au-delà de quelques dizaines de tablettes,
IP fixe ou réservation DHCP pour la machine show, mDNS en secours. Débit négligeable : c'est la stabilité
et la charge par AP qui comptent.

## Check-list « Prêt pour l'antenne » (écran régie)

Médias préchargés sur chaque client ✓ · tablettes connectées et assignées ✓ · horloges synchronisées ✓ ·
sorties ouvertes ✓ · journal actif et disque OK ✓ · chat connecté (si utilisé) ✓.

## Critères de sortie de chaque phase

- `pnpm load` : 500 clients simulés sur une partie complète, 0 réponse perdue, p95 de l'ack < 250 ms (seuil k6) ;
  mesure actuelle ≈ 30 ms (voir `ROADMAP.md`).
- Chaos : couper le Wi-Fi, tuer le serveur, recharger une sortie en pleine question → partie identique à la fin.
