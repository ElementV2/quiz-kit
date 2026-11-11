# Questions ouvertes

## Décisions produit (Morgan)

- [x] Premier show réel visé : **Quiz mixte** (tranché le 2026-11-11).
- [x] Parc de tablettes : **tout** (iPad, Android, téléphones des joueurs) — tester les trois familles (2026-11-11).
- [x] Buzzers physiques : **non**, le buzzer sur tablette suffit (2026-11-11).
- [x] Studio : **sur la machine du show** (2026-11-11).
- [x] Nom du produit : **Quizzkit** (2026-11-11).
- [x] HTTPS sur le LAN : **rester en HTTP** tant qu'aucun besoin réel n'apparaît (2026-11-11, ADR-0012 à mettre à jour).
- [x] Rejeu des journaux d'une version à l'autre : **non requis** ; un journal se rejoue avec la version qui l'a écrit
      (en show le serveur redémarre toujours avec la même version) (2026-11-11).
- [x] Sortie `reveal-image` : image complète sur le PC de sortie **acceptée** (poste de confiance) (2026-11-11).
- [x] Accès équipe distant : blocage **par IP** (sur le LAN chaque appareil a sa propre IP) (2026-11-11).
- [x] `participants.mode` / `min` / `teamSize` : **supprimés** des documents par migration (2026-11-11).
- [x] Format « Maillon faible » : **à ajouter** (2026-11-11).

## Vérifié (2026-11-10)

- [x] **vMix Web Browser** : alpha supporté si le `<body>` n'a pas de fond (« supports transparent backgrounds and
      alpha channel », https://www.vmix.com/help29/WebBrowser.html). Moteur CEF, Chromium 115 depuis vMix 27.
- [x] **OBS Browser Source** : fond transparent par défaut (https://obsproject.com/kb/browser-source), CEF.
- [x] **EBU R 95** (v1.1, 2017, https://tech.ebu.ch/publications/r095) : action safe 3,5 % / graphics safe 5 % par bord,
      soit en 1920×1080 : action safe x 67→1852, y 38→1041 ; graphics safe x 96→1823, y 54→1025. → doc 07.
- [x] **ag-psd** (https://github.com/Agamnentzar/ag-psd) : écriture de calques OK, mais la lib ne génère aucun bitmap
      (« does NOT generate new layer canvas ») : on fournit le rendu de chaque calque. Texte incomplet
      (`invalidateTextLayers` pour forcer Photoshop à redessiner), pas de 16/32 bits en écriture.
- [x] **SQLite WAL** : `synchronous=FULL` obligatoire pour la règle « journal avant diffusion » → ADR-0008.
- [x] **Twitch EventSub** `channel.chat.message` v1 (https://dev.twitch.tv/docs/eventsub/reference/chat) : WebSocket OK,
      **jeton utilisateur** avec `user:read:chat` (jeton app refusé en WebSocket), 3 connexions, 300 abonnements
      par connexion, `max_total_cost` 10 (coût nul si l'utilisateur a autorisé l'app).
- [x] **YouTube Live chat** : utiliser `liveChatMessages.streamList` (streaming gRPC, 5 unités par appel,
      https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList). `list` en polling : 5 unités
      par appel sur 10 000 / jour → ~2,8 h à 1 appel / 5 s.
- [x] **Wake Lock** (MDN) : Chrome Android 84+, iOS 16.4+ mais en PWA écran d'accueil seulement depuis iOS 18.4.
      **Contexte sécurisé obligatoire** (idem Service Workers) → ADR-0012.
- [x] **Packaging** : Bun ne charge pas better-sqlite3 ; Node SEA (Stability 1.1) charge un addon natif extrait en
      fichier temporaire via `process.dlopen()`. → doc 11.
- [x] **Type stripping Node** : stable depuis v24.12.0 / v25.2.0 (https://nodejs.org/api/typescript.html) → ADR-0011.
- [x] **k6** : `k6/websockets` stable depuis v1.6.0 ; pas de résolution de modules Node, bundler requis → ADR-0011.

## À vérifier / mesurer

- [ ] Performances WebGL (PixiJS) dans OBS et vMix : bench phase 2. Pas de doc officielle sur l'accélération GPU de
      l'input vMix ni sur la case « Browser Source Hardware Acceleration » d'OBS.
      Procédure : ajouter `&fx=full&bench=1` (puis `&fx=light`) au lien de sortie dans OBS et dans vMix, lire le
      compteur fps 5 min. Mesuré en Chromium headless (Playwright) : 60 fps en `full`. Garder `light` par défaut
      tant que le bench réel n'est pas fait.
- [ ] Version de Chromium dans vMix 29 (non mentionnée dans les notes de version).
- [ ] Autoplay du son dans OBS Browser Source et dans l'input Web Browser de vMix (sans geste utilisateur) :
      NON VÉRIFIÉ dans une doc officielle. Test : sortie avec `&sound=on`, déclencher une bonne réponse, vérifier
      que le son est capté ; sinon `[data-sound="blocked"]` sur la page.
- [x] ag-psd 34.1 : `readPsd(buffer, { skipLayerImageData, skipThumbnail })` / `writePsd(psd)` vérifiés dans
      `dist/index.d.ts` et `psd.d.ts` (Layer : name, top/left/bottom/right, canvas, children, opened, protected,
      text.style.font.name / fontSize / fillColor). Écriture puis relecture testées (e2e). Constat : un calque
      sans pixels est relu avec des bornes nulles. Sous Node, la lecture exige `skipCompositeImageData` (pas de canvas).
- [ ] PSD réels de graphistes (calques de forme, objets dynamiques, effets) : à valider sur un vrai fichier livré.
- [ ] Twitch : coût exact de `channel.chat.message`, débit max par connexion, keepalive par défaut.
- [ ] YouTube : statut (GA ?) et durée max d'une connexion `streamList`.
- [ ] Mode kiosque sur le parc retenu (Accès guidé iOS / épinglage Android).
- [ ] `node:sqlite` utilisable dans un Node SEA (passage en stable à surveiller).
- [x] Coût du fsync (`synchronous=FULL`) : mesuré sur le PC de dev → group commit nécessaire et implémenté
      (ADR-0008). **À remesurer sur la machine show** (`pnpm load`).
- [ ] Tempête de reconnexions : 500 connexions ouvertes dans la même milliseconde depuis un seul PC Windows voient
      ~40 % de refus TCP immédiats (rattrapés par le backoff en < 1 s). Hypothèse : plafond de la file d'attente TCP
      de Windows édition poste client — NON VÉRIFIÉ dans la doc Microsoft. Si la machine show est un Windows client,
      mesurer un redémarrage serveur avec les vraies tablettes.

- [ ] `OptionId` refuse désormais `__proto__` / `constructor` / `prototype` : un journal écrit avant ce changement avec
      une telle option ne se rechargerait plus (aucun cas connu en phase 0 ; à traiter par migration si besoin).

Règle : une question vérifiée devient un ADR ou une ligne dans le doc concerné, et la case est cochée.
- [ ] Import `.quiz` : plafonner la taille décompressée (par entrée et totale) avant `unzipSync` — archive piégée
      (zip bomb). Usage interne (jeton régie / studio requis), à faire avant toute ouverture plus large. Revue phase 2, M3.

### Phase 3 / 4 (2026-11-11)

- [ ] Twitch Device Code flow : l'étape « token » attend `scopes` (tableau des paramètres) ou `scope` (exemple curl) ?
      La doc se contredit : le code envoie `scopes` ; vérifier au premier essai réel.
- [ ] Twitch : paramètres exacts du refresh pour un client public (sans secret) — NON VÉRIFIÉ ; le code envoie
      `client_id`, `grant_type=refresh_token`, `refresh_token`.
- [ ] Twitch : doublons possibles de notifications sur le transport WebSocket (dédoublonnage par `message_id` en place).
- [ ] YouTube : une clé d'API suffit-elle pour `liveChatMessages.list` (doc muette ; `streamList` l'accepte) ?
      Sinon : OAuth à ajouter. Heure de remise à zéro du quota : non trouvée.
- [ ] Companion « Generic: OSC » en TCP : framing (SLIP ou préfixe de taille) non vérifié — utiliser UDP.
- [ ] Bots de répétition et vote du chat : jamais testés contre une vraie session de 50 tablettes + chat réel.
- [ ] Historique des révélations dans les snapshots (`GameState.history`) : ~2–3 Mo en fin de show à 500 joueurs,
      sérialisés à chaque snapshot (revue phase 3, m2). Mesurer la durée sur la machine show (`pnpm load`).
- [x] Sortie `reveal-image` : la sortie (PC OBS / vMix) reçoit l'image complète, masquée par les cases à l'écran.
      Accepté (poste de confiance, jeton de sortie) ; à revoir si une sortie est un jour exposée au public.
- [x] Accès équipe distant : 30 échecs / min toutes IP bloquent l'accès distant 5 min (déni de service possible
      depuis le Wi-Fi joueurs ; l'accès `localhost` et `links.txt` restent disponibles). Réseau équipe séparé
      recommandé ; à revoir si gênant (revue 4, m4).
- [ ] Desktop : la surveillance du lanceur par PID (`QUIZ_PARENT_PID`) peut être trompée par une réutilisation de PID
      sous Windows ; à la fermeture le serveur est arrêté par `TerminateProcess` (sans perte grâce au journal).
      Mieux : handle / pipe hérité (revue 4, m5–m6).
- [ ] `QUIZ_APPS_DIR` lu hors de `config.ts` (module `http/app.ts`) — à rapatrier dans la config validée (revue 4, m8).
- [ ] `game.patch` journalise le document complet à chaque envoi : taille du journal et durée du rejeu à mesurer
      sur un show avec beaucoup d'envois ; un diff (JSON Patch) serait plus léger (revue 7, m4).
- [x] Rejeu d'un journal ancien : depuis que la question à l'antenne (non révélée) prend les réglages envoyés au
      direct (`reconfigure`), un journal enregistré avant ce changement avec un `game.patch` pendant une question
      peut donner d'autres points au rejeu. Sans effet en show (même version au redémarrage) ; à trancher si les
      journaux doivent rester rejouables d'une version à l'autre (versionner le réducteur ?) (revue 9, m3).
