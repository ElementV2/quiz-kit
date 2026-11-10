# 11 — Stack

**Avant d'installer quoi que ce soit : vérifier la version stable courante et l'API dans la doc officielle
de chaque lib.** Ne pas se fier à des versions écrites ici.

| Brique | Choix | Raison |
|---|---|---|
| Langage | TypeScript strict | Moteur partagé serveur / studio / tests |
| Monorepo | pnpm workspaces + Turborepo | Build et tests par paquet, cache |
| Schémas | Zod | Validation aux frontières, types dérivés |
| Serveur | Node.js LTS + Fastify | Rapide, plugins (static, rate limit) |
| WebSocket | `ws` (uWebSockets.js si bench insuffisant) | Des centaines de clients tiennent dans un process |
| Persistance | SQLite via better-sqlite3, WAL | Un fichier, pas de serveur BDD en tournage |
| Médias | Disque, adressage par hash + ffmpeg | Transcodage à l'import, préchargement fiable |
| Front | SolidJS + Vite | Réactivité fine, sorties fluides |
| Animations | Web Animations API, lottie-web | Natif, pilotable |
| Effets | PixiJS (couche WebGL) | Particules, lumières, reflets |
| Tablettes | PWA, Service Worker, Wake Lock API, IndexedDB | Pas d'app store, cache, file locale |
| Contrôle | HTTP + WS + OSC | Companion / Stream Deck, MIDI |
| Chat | Twitch EventSub (WebSocket), YouTube Live Streaming API | Canaux officiels |
| Tests | Vitest, Playwright, k6 | Moteur, visuel, charge |
| Logs | pino | Structurés, rejouables |
| Packaging (phase 4) | Tauri 2 + serveur compilé (Node SEA ou `bun build --compile`, à trancher par ADR) | Double-clic sur la machine show |

Pourquoi pas Rust côté serveur : la charge ne le justifie pas, et partager le moteur TS vaut plus.
Rust envisagé pour un module NDI natif (phase 5).
