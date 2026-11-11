# Titres vMix (phase 5)

Le serveur tient à jour les champs d'un titre vMix (GT Title Designer ou titre XAML) pendant le show, en plus
(ou à la place) des sorties navigateur. Code : `apps/server/src/vmix/driver.ts`, test `driver.test.ts`.

API vMix utilisée (vérifiée sur vmix.com/help29/DeveloperAPI.html et ShortcutFunctionReference.html) :
`GET http://<PC vMix>:8088/api/?Function=SetText&Input=<titre>&SelectedName=<champ>&Value=<texte>`
(200 = OK, 500 = erreur), `OverlayInput<n>In` / `OverlayInput<n>Out`. Dans un titre GT, un champ texte s'appelle
`<Nom>.Text`. Activer l'API : vMix → Réglages → Web Controller.

## Configuration (régie, jeton régie)

`PUT /api/vmix { "config": { ... } }` (gardée dans `<dataDir>/vmix.json`), `{ "config": null }` pour arrêter ;
`GET /api/vmix` → configuration + état (`sent`, `errors`, `lastError`).

```json
{
  "url": "http://192.168.1.40:8088",
  "input": "Quiz Titre",
  "overlay": 1,
  "fields": {
    "Question.Text": "question.text",
    "Numero.Text": "question.number",
    "A.Text": "option.1", "B.Text": "option.2", "C.Text": "option.3", "D.Text": "option.4",
    "PctA.Text": "option.1.percent",
    "Reponse.Text": "answer",
    "Leader.Text": "leader.name",
    "Premier.Text": "rank.1.name", "PremierScore.Text": "rank.1.total"
  }
}
```

Liaisons : `question.text`, `question.number` (« 2 / 6 »), `round.title`, `phase`, `answer` (bonne réponse,
seulement une fois révélée), `option.<1-8>` / `option.<n>.label` / `option.<n>.percent` (répartition publique),
`leader.name` / `leader.total`, `rank.<1-10>.name` / `rank.<1-10>.total`. Hors question, les champs de question sont
vidés (jamais une question périmée à l'antenne). `overlay` : le titre entre sur ce canal d'overlay quand une question
est à l'antenne et en sort sinon.

Seuls les champs qui changent sont envoyés, une requête après l'autre (la doc vMix demande d'attendre chaque
réponse en TCP ; même règle en HTTP), délai max 3 s par requête. vMix injoignable : le show continue, l'erreur
est dans l'état. Non vérifié : mot de passe du Web Controller appliqué à l'API HTTP (docs/OPEN-QUESTIONS.md).
