# @astratra/srs

Répétition espacée pour les apps d'apprentissage (langues, révisions) : cartes,
notes *Again / Hard / Good / Easy*, prochaine échéance, file du jour et
statistiques. Le calcul des échéances est celui de **FSRS** (algorithme moderne
de mémoire, meilleur que SM-2) fourni par [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs)
(licence MIT) — seule dépendance à l'exécution.

## Exemple

```js
const { createSrs, createMemorySrsStore } = require('@astratra/srs');

const srs = createSrs({
  store: createMemorySrsStore(),      // ou ton propre stockage (voir plus bas)
  params: { request_retention: 0.9 }, // rétention visée
  newCardsPerDay: 20,
  maxReviewsPerDay: 200,
  dayOffsetMinutes: 60,               // le « jour » de l'apprenant (UTC+1 ici)
});

const carte = await srs.addCard({ deckId: 'espagnol', front: 'hola', back: 'bonjour' });

// Les quatre boutons, avec leur délai, sans rien enregistrer :
const options = await srs.preview(carte.id);   // { again, hard, good, easy } → { due, intervalMs }

// L'apprenant répond :
const { nextDue, card } = await srs.review(carte.id, 'good'); // ou 1 à 4

// La file à présenter maintenant :
const file = await srs.dueQueue({ deckId: 'espagnol', limit: 20 });

const stats = await srs.stats({ deckId: 'espagnol' });
// { total, new, learning, review, relearning, suspended, mature, dueNow,
//   reviewsToday, totalReviews, trueRetention, targetRetention }
```

## File du jour

1. cartes en apprentissage ou réapprentissage **déjà échues** ;
2. révisions échues, les plus en retard d'abord, dans la limite de `maxReviewsPerDay` ;
3. cartes nouvelles, dans la limite de `newCardsPerDay` — le quota est **entamé**
   par les cartes neuves déjà vues aujourd'hui.

Les cartes suspendues (`suspend` / `resume`) n'apparaissent jamais.

## Paramètres FSRS

`createSrsParams(surcharges)` valide puis complète : `request_retention` (]0, 1]),
`maximum_interval`, `learning_steps`, `relearning_steps`, `enable_fuzz`,
`enable_short_term`, `w` (17, 19 ou 21 poids). `ts-fsrs` corrige en silence les
valeurs hors limites ; ici elles sont **refusées** (`RangeError`).

## Stockage injectable

Un stockage est un objet avec `get(id)`, `put(carte)`, `remove(id)`, `list({ deckId })`,
`addLog(entrée)` et `listLogs({ deckId, since })` (synchrones ou asynchrones).
Tout ce qui est stocké est sérialisable en JSON : les dates sont des chaînes ISO.
`createMemorySrsStore()` est fourni pour les tests.

## Rétention réelle

`stats().trueRetention` = part des réponses autres que *Again* parmi les cartes
déjà en révision ; `null` tant qu'il n'y en a pas. À comparer à `targetRetention`.
