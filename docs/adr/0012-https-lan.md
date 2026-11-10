# ADR-0012 — HTTPS sur le LAN plateau

- Statut : proposé (à trancher avant la tâche `player` de la phase 1)
- Date : 2026-11-10

## Contexte
Wake Lock et Service Workers n'existent qu'en contexte sécurisé :
- https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API — « Service workers are only available in
  secure contexts: this means that their document is served over HTTPS, although browsers also treat
  `http://localhost` as a secure context ».
- https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API — « This feature is available only in
  secure contexts (HTTPS) ».
Donc `http://<ip-show>` sur les tablettes = ni Wake Lock, ni cache média, ni PWA. Les sorties OBS / vMix
(chargées par la machine show ou via localhost) ne sont pas concernées.

## Options
1. **CA locale** (générée par l'installation) + profil installé sur chaque tablette (profil MDM / réglage iOS
   « Confiance des certificats », certificat utilisateur Android). Fonctionne hors internet.
2. **Nom DNS interne + certificat public** (ACME DNS-01 sur un domaine de l'équipe, résolu en IP LAN). Aucune
   install sur les tablettes, mais renouvellement à faire avant le show (internet nécessaire hors show).

## Décision
À prendre avec Morgan selon le parc de tablettes (voir `OPEN-QUESTIONS.md`). Le serveur supporte HTTPS dès la
phase 0 (certificat + clé passés en configuration) ; HTTP reste possible pour le dev.
