# Étude — sortie NDI native (phase 5)

Question : émettre les sorties 1920×1080 directement en NDI®, sans passer par OBS / vMix.
NDI® is a registered trademark of Vizrt NDI AB (https://ndi.video).

## Ce qui est vérifié (docs.ndi.video, 2026-11-11)

- **NDI SDK standard** : sans redevance selon son License Agreement, avec obligations : lien vers ndi.video près
  de chaque mention, mention de marque dans « À propos », DLL NDI installées **dans le dossier de l'application**,
  pas de redistribution des NDI Tools. La FAQ dit aussi « free to use for non-commercial purposes » : formulation
  ambiguë → faire lire le License Agreement avant toute redistribution hors de l'équipe.
- **NDI Advanced SDK** : pour fabricants (KVM, genlock, flux compressés…), contrat commercial ; inutile ici.
- **Bindings** : aucun binding officiel Rust ni Node. Crates communautaires : `ndi-sdk-sys` (GPL-3.0,
  contaminante), `grafton-ndi`, `ndi-sdk` (licences à vérifier une par une).

## Options

1. **Ne rien faire de plus (recommandé aujourd'hui)** : OBS et vMix captent la sortie navigateur et l'émettent
   eux-mêmes en NDI (vMix nativement, OBS via le plugin DistroAV). Zéro redistribution NDI de notre part, zéro
   code natif, déjà testé avec nos sorties transparentes.
2. **Sidecar Rust « quiz-ndi »** : une WebView hors écran (ou Chromium headless) rend `/out/<scène>`, capture les
   images (BGRA + alpha) à 50/60 i/s et les envoie par FFI directe sur l'API C du SDK (`NDIlib_send_create`,
   `NDIlib_send_send_video_v2`). Points durs : capture hors écran avec alpha et cadence stable (pas d'API Tauri
   pour ça : WebView2 `CapturePreview` est une capture ponctuelle PNG, trop lente), audio, coût CPU d'un rendu
   par sortie, packaging des DLL NDI à côté de l'exe, licence.
3. **Addon Node natif** : mêmes points durs, plus un rendu navigateur à piloter depuis Node (Puppeteer +
   screencast CDP à 30 i/s max en JPEG) — qualité et cadence insuffisantes pour l'antenne.

## Décision

Option 1 tant qu'un besoin réel (pas d'OBS / vMix sur le plateau, ou latence mesurée trop haute) n'est pas
établi. Prérequis avant l'option 2 : lecture juridique du License Agreement NDI, prototype de capture hors écran
avec alpha à 50 i/s sur la machine show, mesure CPU. La case « Sortie NDI native » reste ouverte à ce titre.
