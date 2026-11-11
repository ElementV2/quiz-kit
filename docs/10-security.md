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
- `secret.key` : 64 caractères hexadécimaux, écrit de façon atomique ; un fichier vide ou tronqué empêche le démarrage
  (sinon n'importe qui pourrait signer un jeton). Une installation qui a tourné avant cette version gardait le secret
  dans `journal.db` : avant de transmettre un journal pour une contestation, faire tourner le secret.
- Un jeton révoqué coupe immédiatement sa connexion (plus aucune vue ni intention, même si le client ignore la fermeture).

## Code équipe (accueil `/`)

Le code équipe donne tous les liens à jetons (régie comprise) : il vaut un jeton régie. 8 caractères sans
confusion possible (ni 0/O ni 1/I/L, ~10¹² combinaisons). Il ne quitte que le PC du serveur (affiché en
`localhost`, `links.txt` en 0600), n'est jamais journalisé, comparé en temps constant, limité à 10 essais par
minute et par IP (par appareil : un joueur qui essaie des codes sur le Wi-Fi ne bloque jamais l'équipe ;
~10¹² combinaisons restent hors de portée même depuis des centaines d'adresses). Le renouveler avant chaque
show ou après une fuite : régie → « Nouveau code équipe » (`POST /api/staff/rotate`), ou `QUIZ_STAFF_CODE`.
Derrière un proxy local (`X-Forwarded-For` présent), personne n'est « local » : le code est toujours exigé.
Un poste peut retenir le code (stockage du navigateur) : « Verrouiller ce poste » l'efface.

