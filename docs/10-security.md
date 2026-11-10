# 10 — Sécurité (interne, mais pas naïf)

- **Jetons par rôle et par show** signés (HMAC, secret par installation), révocables, avec expiration.
  Le jeton de sortie et le jeton de siège peuvent vivre dans l'URL (OBS, QR code) : ils sont en lecture seule
  ou limités à leur siège.
- PIN régie / animateur hachés (argon2 ou équivalent, à valider dans un ADR).
- Validation Zod de tout message entrant, taille max, rate limit par appareil et par rôle.
- Projections serveur : aucune donnée secrète (bonne réponse, valeurs de sondage non révélées, notes
  animateur) dans une vue `player` ou `output` avant révélation. Test « no-leak » par mécanique.
- Serveur lié à l'interface réseau du plateau ; aucune exposition internet. Distance = VPN interne.
- CORS fermé, en-têtes de sécurité, CSP stricte sur les apps front.
- Texte libre (pseudos, réponses, chat) toujours rendu comme du texte, jamais comme du HTML.
- Secrets (clés Twitch / YouTube) stockés côté serveur uniquement, jamais envoyés aux fronts.
- Logs sans secrets ni jetons.
