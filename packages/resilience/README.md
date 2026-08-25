# @astratra/resilience

Trois protections contre les dépendances qui tombent : le disjoncteur, le cache
qui se dégrade au lieu d'échouer, et la relance avec brouillage.

Aucune dépendance à l'exécution.

## Le disjoncteur

Une dépendance en panne n'échoue pas simplement — elle échoue **lentement**.
Chaque appel attend son délai d'expiration, les requêtes s'empilent derrière,
et une API tierce morte emporte ton propre service avec elle. Le disjoncteur
remplace l'échec lent par un échec rapide : après assez d'erreurs consécutives
il **s'ouvre**, et les appelants reçoivent un refus immédiat au lieu d'une
socket qui pend.

```js
const { createCircuitBreaker } = require('@astratra/resilience');

const iaBreaker = createCircuitBreaker({
  name: 'service-ia',
  failureThreshold: 3,
  recoveryMs: 20_000,
  // Un 404 est une réponse, pas une panne : compter les erreurs métier
  // ouvrirait le circuit sur un service en pleine santé.
  isFailure: (e) => !e.statusCode || e.statusCode >= 500,
  onStateChange: ({ name, from, to }) => logger.warn(`${name}: ${from} → ${to}`),
});

const reponse = await iaBreaker.call(() => axios.post(url, payload));
```

### La sonde est singulière, et c'est le point

Passé le délai, le circuit passe en semi-ouvert et laisse passer **un seul**
appel pour tâter le terrain. Laisser passer tous les appelants en attente
« pour tester » signifie qu'à la seconde où le délai expire, un troupeau
entier frappe un service probablement encore à genoux — l'engorgement que le
disjoncteur devait empêcher, livré à l'heure.

Une sonde qui échoue rouvre **immédiatement** : une mauvaise réponse suffit
comme preuve, pas besoin de recompter jusqu'au seuil. Et le délai repart de
cet échec-là.

`reset()` referme la porte sans attendre — pour l'opérateur qui vient de
déployer le correctif.

## Le cache

Le propre d'un cache est que son absence soit survivable. Donc rien ne lève
jamais ici : un store cassé se lit comme une absence, une écriture ratée est
journalisée et abandonnée. Dès qu'un cache peut faire tomber une requête, il
est devenu une dépendance — le contraire de son travail.

```js
const { createCache } = require('@astratra/resilience');

const cache = createCache({ prefix: 'stats', ttlSeconds: 300 });

// L'idiome cache-aside, écrit une fois :
const stats = await cache.remember('dashboard:s9', () => computeDashboard(schoolId));
```

### `remember` protège de la ruée

À la seconde où une entrée populaire expire, chaque requête partirait sinon
frapper la base avec la même question. Sous concurrence, **un seul** calcul
tourne par clé — les appelants parallèles attendent la même promesse en vol.

Deux autres choix testés : `null` n'est pas mis en cache (« rien » aujourd'hui
ne doit pas masquer « quelque chose » pendant cinq minutes), et l'éviction
mémoire retire le **moins récemment utilisé**, pas la plus vieille écriture.

Le store est injecté — Redis en production, `createMemoryCacheStore()` partout
ailleurs, même code.

## La relance

Deux règles portent toute la valeur :

**Le recul avec brouillage.** Relancer immédiatement martèle un service déjà en
difficulté ; relancer à intervalle fixe synchronise tous les clients en vagues
qui arrivent ensemble. Un délai croissant à composante aléatoire étale la
charge.

**Ne relancer que ce qui peut changer.** Un délai dépassé peut réussir la
prochaine fois ; un 400 non — la requête est fausse, et l'envoyer trois fois ne
la rend pas plus juste. Par défaut, tout statut sous 500 n'est **pas** relancé.

```js
const { retry } = require('@astratra/resilience');

const data = await retry(() => fetchFromProvider(id), {
  attempts: 3,
  baseDelayMs: 200,
  onRetry: (e, attempt, delay) => logger.warn(`essai ${attempt} raté, reprise dans ${delay}ms`),
});
```

Et le rappel qui compte : ce qui n'est **pas idempotent** — un paiement, un
envoi — ne se relance pas aveuglément. Le premier essai a peut-être réussi sans
que tu entendes la réponse. `shouldRetry` est là pour le dire.

## Les trois ensemble

```js
const donnee = await cache.remember(cle, () =>
  iaBreaker.call(() => retry(() => provider.ask(prompt)))
);
```

Le cache absorbe, le disjoncteur coupe, la relance lisse.

## Tests

```bash
npm test --workspace @astratra/resilience
```
