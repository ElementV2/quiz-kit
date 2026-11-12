# ADR-0017 — « Image dévoilée » sur les tablettes : cases découpées par le serveur (sharp)

- Statut : accepté
- Date : 2026-11-12

## Contexte
Décision produit (2026-11-12) : les joueurs voient sur leur tablette la même image que l'écran, case par case. La règle
« aucune donnée secrète côté client » (CLAUDE.md, doc 10) interdit d'envoyer l'image entière masquée : son empreinte
ouvre `/media/<hash>` (public, adressé par contenu) et un joueur la récupérerait avant la révélation. Le serveur doit
donc découper l'image et ne servir que les cases déjà dévoilées. Le serveur n'avait aucune bibliothèque d'image.

Vérifié : `npm view sharp` → 0.35.5 (dernière stable, `engines.node >= 20.9`), binaires précompilés (libvips incluse)
pour win32-x64 via `@img/sharp-win32-x64`, sans script d'installation (rien à ajouter à `allowBuilds`). Essayé sous
Node 26.13 : `extract()` puis `webp()` fonctionnent.

## Décision
- `sharp` 0.35.5 dans `apps/server`, chargé à la première case seulement (`import()` dynamique) : s'il ne se charge pas
  sur une machine, le show continue, seules les cases des tablettes manquent (l'écran a toujours l'image).
- `GET /api/tile/<question>/<case>` : lit la vue régie de l'état en direct ; sert la case (WebP) seulement si la
  question à l'antenne est cette question `reveal-image` et que la case est dévoilée (toutes à la révélation), sinon
  404. `cache-control: no-store` (une case refusée doit se charger une fois dévoilée ; un undo ne laisse rien en cache).
- La vue `reveal-image` gagne `aspect` (largeur / hauteur, non secret) ; `image` reste `null` pour les joueurs, même
  après la révélation (les cases suffisent).
- Coût à la révélation (toutes les cases demandées par toutes les tablettes en même temps) : chaque image est décodée
  une fois, redressée, réduite à 1600 px de grand côté et gardée en mémoire brute (3 images au plus) ; chaque case
  en est découpée une fois (WebP) et gardée (400 au plus). Une image illisible est retenue comme telle (pas de décodage
  par requête) ; une image absente du disque (secours qui la copie encore) est réessayée. Une seule projection de la
  vue régie par état de partie, pas une par requête.
- La tablette prend la forme de la grille sur la première case reçue (l'orientation EXIF est appliquée aux cases),
  `aspect` ne sert qu'à la placer avant.
- Paquet Windows : `sharp` est externe au bundle esbuild et copié avec ses dépendances (`@img/colour`,
  `@img/sharp-<plateforme>` avec libvips, `detect-libc`, `semver`) dans `resources/server/node_modules`
  (`apps/desktop/tools/prepare.ts`), puis chargé depuis ce dossier pour vérifier que la copie suffit.

## Alternatives écartées
- Image entière envoyée et masquée sur la tablette — fuite de la réponse (doc 10).
- Découpage dans le studio à l'enregistrement (une image par case) — lie le contenu à la grille de la manche
  (changer colonnes / lignes, ou jouer la question dans une autre manche, obligerait à tout redécouper).
- Bibliothèque JavaScript pure (jimp 1.6.1) — plus lente au décodage de grandes photos, au moment où 100 tablettes
  demandent la même case ; sharp est la référence et a des binaires pour toutes les cibles.
- Tablette « Regardez l'écran » sans image — écarté par le produit.

## Conséquences
- Une case dévoilée puis annulée (undo) reste sur les tablettes qui l'ont déjà reçue, comme sur l'écran.
- Les cases sont publiques une fois dévoilées (pas de jeton) : ce qu'elles montrent est déjà à l'antenne.
- Surveiller : temps de découpe d'une grande photo au premier appel (une seule découpe par case, puis la mémoire).
