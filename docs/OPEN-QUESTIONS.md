# Questions ouvertes

## Décisions produit (Morgan)

- [ ] Premier show réel visé → premier template à rendre irréprochable.
- [ ] Parc de tablettes (iPad, Android, mixte) et qui les fournit.
- [ ] Buzzers physiques dès la phase 1, ou buzzer sur tablette suffisant ?
- [ ] Studio sur la machine show, ou serveur interne séparé qui pousse les jeux ?
- [ ] Nom du produit.

## À vérifier dans la doc officielle avant implémentation

- [ ] Transparence de l'input Web Browser de vMix (sinon fond vert ou alpha séparée).
- [ ] Zones de sécurité : valeurs exactes dans EBU R 95.
- [ ] Écriture PSD avec calques via ag-psd (qualité, compatibilité Photoshop / Figma).
- [ ] SQLite WAL : niveau `synchronous` nécessaire pour survivre à une coupure de courant, et son coût.
- [ ] Twitch EventSub `channel.chat.message` : scopes, limites, transport WebSocket.
- [ ] YouTube Live chat : quotas de l'API et mode de lecture (polling ou streaming) disponible.
- [ ] Performances WebGL (PixiJS) dans la Browser Source d'OBS et dans vMix.
- [ ] Wake Lock API et mode kiosque sur le parc de tablettes retenu.
- [ ] Packaging serveur : Node SEA vs `bun build --compile` (support de better-sqlite3 natif).

Règle : une question vérifiée devient un ADR ou une ligne dans le doc concerné, et la case est cochée.
