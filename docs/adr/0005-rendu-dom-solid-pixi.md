# ADR-0005 — Rendu DOM (SolidJS) + couche d'effets WebGL (PixiJS)

- Statut : accepté
- Date : 2026-11-10

## Contexte
Texte net et éditable, polices réelles, rendu identique studio / antenne, et des effets « prime time ».

## Décision
Zones, cadres et textes en DOM/CSS rendus par SolidJS. Particules, lumières, reflets dans une couche
PixiJS superposée. Niveaux de qualité des effets (complet / allégé / désactivé).

## Alternatives écartées
- Tout en canvas / WebGL : texte et accessibilité de l'édition plus durs, gros chantier de mise en page.
- Moteur natif (C++ / D3D, type videmix) : hors périmètre, perd l'usage OBS / vMix par URL.

## Conséquences
Bench obligatoire en phase 2 dans OBS et vMix avant de fixer le niveau d'effets par défaut.
