# Chat Twitch / YouTube — vote du public (`crowd-vote`)

La seule dépendance internet autorisée pendant un show (CLAUDE.md n° 7). Code : `apps/server/src/chat/`
(`ingest.ts`, `twitch.ts`, `youtube.ts`, `chat-hub.ts`), mécanique `packages/engine/src/mechanics/crowd-vote/`.
Faits vérifiés dans les docs officielles le 2026-11-11 (sources ci-dessous) ; points non vérifiés dans
`docs/OPEN-QUESTIONS.md`.

## Principe

- Une manche `crowd-vote` (question `single` ou `poll`) : les spectateurs votent dans le chat par la lettre
  (`A`, `!b`, `c)`), le numéro (`2`) ou le texte de la proposition.
- Le serveur regroupe les votes toutes les 300 ms en **une** action `crowd.tally` (acteur `system`), jamais un
  événement de journal par message. Un vote par spectateur (le dernier compte), anti-spam : 1 vote par seconde
  et par spectateur, 1 000 votes au plus par lot.
- `streamDelayMs` (config de la manche) : les votes comptent encore ce délai après la fermeture — le stream
  arrive en retard chez les spectateurs.
- Résultat : majorité révélée à l'antenne ; avec `teamId` + `points`, l'équipe « Le chat » marque si la
  majorité a raison. Les tablettes ne reçoivent jamais la répartition (poids, elle change toutes les 300 ms).

## Twitch (EventSub WebSocket)

Configuration : `QUIZ_TWITCH_CLIENT_ID` = Client ID d'une application Twitch **publique** (console
dev.twitch.tv, type de client « Public », sans secret).

1. Régie → Outils → Chat → « Connecter le compte Twitch » : `POST /api/chat/twitch/login` renvoie l'adresse
   (`https://www.twitch.tv/activate`) et un code à saisir (Device Code Grant Flow, scope `user:read:chat`).
   Les jetons sont gardés dans `<dataDir>/twitch-token.json` (0600, écriture atomique : le refresh token d'un
   client public ne sert qu'une fois).
2. « Lire le chat de » `<chaîne>` : `POST /api/chat/twitch/start { channel }` → connexion
   `wss://eventsub.wss.twitch.tv/ws`, abonnement `channel.chat.message` v1 dans les 10 s du `session_welcome`.
   Keepalive manqué → nouvelle connexion et nouvel abonnement ; `session_reconnect` suivi tel quel. En chat
   partagé, les messages d'autres chaînes sont ignorés (`source_broadcaster_user_id`).

Sources : dev.twitch.tv/docs/eventsub/handling-websocket-events · dev.twitch.tv/docs/eventsub/reference/chat ·
dev.twitch.tv/docs/api/reference/eventsub · dev.twitch.tv/docs/authentication/getting-tokens-oauth.

## YouTube (Data API v3, polling)

Configuration : `QUIZ_YOUTUBE_API_KEY`. « Lire le chat de la vidéo » `<id>` : `POST /api/chat/youtube/start
{ videoId }` → `videos.list?part=liveStreamingDetails` (1 unité) → `activeLiveChatId`, puis
`liveChat/messages` (5 unités par appel) au rythme `pollingIntervalMillis`. La première page (messages
antérieurs) est ignorée. Quota par défaut 10 000 unités / jour ≈ 2 h 45 de polling continu : ne lancer la lecture
que pendant les manches de vote. Le flux gRPC `streamList` existe mais n'est pas utilisé (dépendance gRPC).

Sources : developers.google.com/youtube/v3/live/docs/liveChatMessages/list · …/videos/list ·
developers.google.com/youtube/v3/getting-started.

## Routes (jeton régie)

`GET /api/chat` (état des connecteurs + compteurs : reçus, votes, ignorés, limités, lots) ·
`POST /api/chat/twitch/login` · `POST /api/chat/twitch/start {channel}` · `POST /api/chat/twitch/stop` ·
`POST /api/chat/youtube/start {videoId}` · `POST /api/chat/youtube/stop`.

## Limites connues

- Le chat ne crée pas de joueurs : `crowd-vote` est un vote collectif, pas un classement individuel du chat.
- Non testé contre les vrais services (tests sur doubles conformes à la doc) : faire un essai réel en
  répétition avant le premier show.
