# ADR-0012 — Tablettes en HTTP simple, sans certificat ni installation

- Statut : accepté (remplace la version « proposé » du 2026-11-10)
- Date : 2026-11-11

## Contexte
Les tablettes sont souvent **louées par lots de ~100** : impossible d'y installer un certificat ou un profil MDM.
Sur `http://<ip-show>:7300`, la page n'est pas un contexte sécurisé (MDN, Secure Contexts : seuls https/wss/file,
127.0.0.0/8, ::1, localhost sont « potentially trustworthy »). Vérifié le 2026-11-11 sur MDN
(https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts) :
- **indisponibles en HTTP** : Service Worker, Cache API, Screen Wake Lock, `crypto.randomUUID`, `navigator.storage.persist`,
  `Cache-Control: immutable` ;
- **disponibles** : IndexedDB, localStorage, Fullscreen (geste utilisateur), `crypto.getRandomValues`
  (« the only member of the Crypto interface which can be used from an insecure context »), Web Audio, cache HTTP `max-age`.

## Décision
Les apps n'utilisent **aucune API réservée aux contextes sécurisés** :
- clés d'idempotence : `crypto.getRandomValues` ;
- file d'intentions : `localStorage` (`localStorageIntentStore`) ;
- médias : URL adressées par hash avec `Cache-Control: max-age=31536000` + préchargement en mémoire (blob) ; pas de
  Service Worker ;
- écran allumé : au tap « Rejoindre », plein écran + vidéo muette en boucle `playsinline` (autoplay muet autorisé,
  https://webkit.org/blog/6784/new-video-policies-for-ios/). **Qu'une vidéo empêche la veille n'est documenté nulle
  part officiellement** (NON VÉRIFIÉ) : à valider sur le parc en répétition. En cas d'échec, la veille n'est pas grave :
  la tablette se reconnecte, resynchronise sa vue et renvoie ses réponses non acquittées ; la régie la voit
  « déconnectée » et la procédure de location peut demander « mise en veille : jamais ».

## Alternatives écartées (ou reportées)
- CA locale installée sur chaque tablette : impossible sur un parc loué.
- **Option B (plus tard, si l'équipe a un domaine)** : certificat Let's Encrypt public pour `quiz.<domaine>` obtenu par
  DNS-01 (https://letsencrypt.org/docs/challenge-types/ — « validate domain names whose webservers aren't exposed to the
  public internet »), nom résolu vers l'IP LAN par un DNS local maîtrisé (dnsmasq sur la machine show, évite la
  protection anti-rebinding des box et la dépendance internet). Aucune installation sur les tablettes, Wake Lock et
  Service Worker deviennent disponibles. Contraintes : renouvellement avant chaque show (durée par défaut 90 j, 64 j
  en février 2027, 45 j en 2028 — https://letsencrypt.org/2025/12/02/from-90-to-45), identifiants d'API DNS à protéger.

## Conséquences
Rien à installer, rien à renouveler, zéro internet. Le code doit rester testable en HTTP (Playwright charge les apps
sur une IP LAN, pas localhost, pour détecter toute API sécurisée glissée par erreur).
