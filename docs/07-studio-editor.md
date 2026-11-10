# 07 — Studio (`apps/studio`)

## Trois modes

1. **Contenu** : tableur de questions (une ligne = une question, colonnes selon `answerSpec.kind`),
   coller depuis Excel/Sheets, import CSV, panneau détail (médias, indices, synonymes, sondage), validation live.
2. **Format** : timeline de manches en cartes (mécanique, source, qui répond, révélation, chrono, score,
   fin), blocs de règles et jokers. Mode avancé : graphe de la machine d'états (phase 5).
3. **Scènes** : canvas.

## Canvas

- Taille de la scène (1920×1080 par défaut, vertical, tablette), grille, repères, safe areas EBU R 95
  (action safe 3,5 % = 67×38 px, graphics safe 5 % = 96×54 px par bord en 1080p ; voir `OPEN-QUESTIONS.md`).
- Palette de zones typées ; binding auto à l'évidence, modifiable dans l'inspecteur.
- Inspecteur à onglets d'états + « simuler l'état » (le moteur tourne en local sur un état fictif).
- Alignement, distribution, duplication de zones répétées, verrouillage de calques, undo/redo (commandes).

## Trois façons de créer le visuel

### A. Design reçu → poser les zones dessus
- Import de la maquette en calque de référence (PNG/JPG, SVG, PDF, PSD si lisible, export Figma).
- Tracer les zones par-dessus, dupliquer / aligner les répétées.
- Découpe du fond de zone depuis une maquette plate, marqueurs 9-slice à la souris.
- États manquants dérivés automatiquement (teinte, glow, désaturation), modifiables.
- PSD avec calques nommés selon convention → zones créées automatiquement.
- Pipette police/couleur sur la maquette.

### B. Gabarit → le graphiste livre propre
- Export par scène : gabarit 1920×1080 (PNG + SVG) avec zones, noms, coordonnées, tailles, 9-slice,
  safe areas, texte le plus long posé ; fichier calques (PSD via ag-psd si validé, sinon SVG multi-calques) ;
  fiche assets (PDF + CSV : fichier, zone, x, y, w×h 1x, taille 2x, 9-slice, états).
- Une zone répétée = un fichier par état, pas un par case.
- Réimport par convention de nommage (`<zone>_<state>@2x.png`), rapport des manquants / mauvaises tailles.
- Zone agrandie après livraison : 9-slice OK, sinon asset marqué « à refaire » et fiche régénérée.

### C. Généré dans l'app
Moteur de thèmes (voir `06-scenes-renderer.md`).

## Assets à taille fixe

Fond 1920×1080 (livrer 3840×2160), stinger 1920×1080 ProRes 4444 ou WebM VP9 alpha (transcodé par l'app),
logo SVG (sinon PNG alpha ≥ 1000 px de large), avatar carré ≥ 512×512, sons WAV 48 kHz.
Contrôles à l'import : dimensions, alpha, licence de police déclarée, échantillonnage audio (conversion auto).

## Templates

Format + Scènes + Thème + set d'exemple : QCM à paliers, sondage à slots, buzzer culture G, blind test,
Jeopardy, quiz chat Twitch, Kahoot-like 50 joueurs. On reprend les mécaniques, jamais les habillages ou logos des émissions.

## Mode Répétition

Session simulée avec bots joueurs (nombre, taux de bonnes réponses, latence) pour tester un format et ses scènes.
