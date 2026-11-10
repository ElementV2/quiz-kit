# 10 — Sécurité (interne, mais pas naïf)

- **Jetons par rôle et par show** signés (HMAC-SHA256, secret par installation dans `secret.key`, hors du journal),
  déterministes (un lien collé dans OBS survit aux redémarrages), révocables lien par lien (`POST /api/revoke`
  avec le jeton régie : la connexion ouverte est coupée et un nouveau lien est émis). Les liens de show n'expirent
  pas, volontairement (une source OBS ne doit pas mourir en plein show) ; pour tout révoquer : supprimer `secret.key`.
  Le jeton de sortie et le jeton de siège peuvent vivre dans l'URL (OBS, QR code) : lecture seule ou limités au siège,
  `Referrer-Policy: no-referrer`.
- PIN régie / animateur hachés (argon2 ou équivalent, à valider dans un ADR).
- Validation Zod de tout message entrant, taille max, rate limit par appareil et par rôle.
- Projections serveur : aucune donnée secrète (bonne réponse, valeurs de sondage non révélées, notes
  animateur) dans une vue `player` ou `output` avant révélation. Test « no-leak » par mécanique.
- Serveur lié à l'interface réseau du plateau ; aucune exposition internet. Distance = VPN interne.
- CORS fermé, en-têtes de sécurité, CSP stricte sur les apps front.
- Texte libre (pseudos, réponses, chat) toujours rendu comme du texte, jamais comme du HTML.
- Secrets (clés Twitch / YouTube) stockés côté serveur uniquement, jamais envoyés aux fronts.
- Logs sans secrets ni jetons (URL masquées, 404 sans log d'URL ; les liens ne s'affichent que sur une console
  interactive, sinon seul le chemin de `links.txt` est imprimé). `/health` public ne renvoie que `{ ok: true }`.
