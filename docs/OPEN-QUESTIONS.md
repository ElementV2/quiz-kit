# Questions ouvertes

## Décisions produit (Morgan)

- [ ] Premier show réel visé → premier template à rendre irréprochable.
- [ ] Parc de tablettes (iPad, Android, mixte) et qui les fournit. **Conditionne ADR-0012 (HTTPS LAN)** et
      Wake Lock en PWA (iOS ≥ 18.4 requis pour une PWA écran d'accueil).
- [ ] Buzzers physiques dès la phase 1, ou buzzer sur tablette suffisant ?
- [ ] Studio sur la machine show, ou serveur interne séparé qui pousse les jeux ?
- [ ] Nom du produit.
- [ ] HTTPS sur le LAN : CA locale installée sur les tablettes, ou certificat public sur un nom DNS interne (ADR-0012).

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
