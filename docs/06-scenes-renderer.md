# 06 — Scènes, habillage et rendu (`packages/renderer`)

## Principe

Une `Scene` + une `View` projetée → du DOM. Le même composant `<SceneRenderer>` sert au studio
(aperçu et canvas), aux sorties antenne et aux écrans animateur. Ce qu'on voit dans le studio est ce qui part à l'antenne.

## Zones

- Registre de types de zones (`registerZone(type, Component, schema)`).
- Une zone lit **uniquement** sa donnée bindée et son état ; elle ne connaît pas le jeu.
- `repeat` : une zone gabarit répétée sur une collection (`answers`, `slots`, `leaderboard`) avec layout (grille, colonne, libre).
- Texte : auto-fit dans la `textBox`, alerte si le texte le plus long du set déborde.
- 9-slice pour les cadres (CSS `border-image` ou équivalent, à valider sur les navigateurs cibles).

## Couches

Couches numérotées par sortie (fond 0, plateau 10, scores 20, classement 30, infos 40, chrono/alertes 50,
plein écran 90). Modes `auto`, `manual` (TAKE/OUT), `auto-hold` (le moteur prépare, la régie valide).

## Animations et moments

- IN / OUT / CHANGE par élément, presets (fondu, glissement, wipe, scale, flip, compteur), stagger.
- Web Animations API pour le DOM ; lottie-web pour les Lottie ; vidéo WebM avec alpha pour les stingers.
- **Moments** déclenchés par événement moteur (bonne réponse, faux, suspense, 5 dernières s, palier, leader,
  podium, élimination, barrage) : timeline d'anims + particules + son.
- Effets (particules, lumières, reflets) dans une **couche WebGL PixiJS** au-dessus du DOM.
  Niveaux de qualité : complet / allégé / désactivé. Bench dans OBS et vMix avant de choisir le défaut.
  **Implémenté** : `detectMoments(prev, next)` (renderer, pur, testé) compare deux vues projetées — jamais
  rejoué au rechargement ; `Effects` charge PixiJS à la demande (rien si `?fx=off`), fond transparent, CSP
  stricte conservée grâce à `pixi.js/unsafe-eval` (polyfills sans `eval`). Paramètres du lien de sortie :
  `?fx=full|light|off` (défaut `light`), `?bench=1` (émission continue + compteur fps).

## Thèmes

Tokens (couleurs avec rôles, polices, arrondis), matériau des cadres (aplat, dégradé, verre, métal, néon,
papier, LED), décor animé, personnalité de mouvement, pack sonore, moments.
Génération depuis 2 couleurs + logo : palette dérivée, contrôle de contraste, 3 à 4 variantes.
Thèmes prédéfinis originaux (aucune reprise d'habillage d'émission existante).

**Implémenté** : `material` (aplat, dégradé, verre, métal, néon, papier, LED) = variables `--q-mat-*` peintes
par-dessus la couleur d'état (bonne / mauvaise / sélection restent lisibles), CSS pur sans `color-mix()`.
`logo` (hash média) : zone `image` avec `src: "logo"` ; dans le studio, ses 2 teintes dominantes
(`dominantColors`, gris / transparent ignorés) alimentent le générateur. `sounds` : un son par moment
(`SoundCue` = bonne / mauvaise réponse, 5 dernières s, buzzer, palier, leader, podium) + `volume`.
Le logo et les sons sont des médias du jeu : préchargés par les clients et inclus dans l'export `.quiz`.

## Sorties

Une URL par scène (`/out/<show>/<scene>`), fond transparent, 1920×1080 fixe, lecture seule.
Son de l'habillage : embarqué dans la sortie (capturé par OBS/vMix) ou coupé, au choix.
**Implémenté** : coupé par défaut, `&sound=on` sur le lien de sortie pour l'embarquer. Un son refusé par la
politique d'autoplay du navigateur ne casse rien (`[data-sound="blocked"]` pour le diagnostic).
