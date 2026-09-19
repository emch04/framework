# @astratra/core

Briques de base partagées, indépendantes de tout framework, utilisées par
tous les autres packages Astratra : format de réponse API, gestion
d'erreurs, logs, identifiant de requête, validation et chargement de
variables d'environnement. Aucune base de données, aucun ORM, aucune
logique métier.

## Installation

Dans le monorepo, les autres packages en dépendent via `file:../core`. Hors
monorepo, ce serait une dépendance npm classique une fois publié.

## Contenu

```js
const {
  apiResponse,        // (res, statusCode, message, data, success) => envoie une réponse JSON unifiée
  asyncHandler,        // (fn) => wrapper middleware Express qui transmet les erreurs à next()
  createLogger,        // (serviceName) => { info, warn, error, debug } — no-op si NODE_ENV=test
  AppError,             // classe AppError extends Error — porte un statusCode
  errorMiddleware,      // gestionnaire d'erreurs Express — masque message/stack en production, logge les 5xx via req.log ou console
  notFoundMiddleware,   // gestionnaire 404 Express via apiResponse
  requestIdMiddleware,  // attache req.requestId (header X-Request-Id, respecte un id entrant)
  validateMiddleware,   // (validations) => exécute des validations express-validator, 400 si échec
  loadEnv,               // (schema) => lit process.env avec valeurs par défaut/requis/transform/validate
  idempotencyMiddleware, // (options) => une écriture rejouée avec la même clé ne s'exécute qu'une fois
  createIdempotency,     // (options) => le même moteur, hors HTTP (tâches, files, RPC)
  createMemoryIdempotencyStore
} = require('@astratra/core');
```

## Exemple

```js
const express = require('express');
const { apiResponse, asyncHandler, errorMiddleware, notFoundMiddleware, requestIdMiddleware, AppError } = require('@astratra/core');

const app = express();
app.use(requestIdMiddleware);

app.get('/ping', asyncHandler(async (req, res) => {
  return apiResponse(res, 200, 'pong', { requestId: req.requestId });
}));

app.get('/boom', asyncHandler(async () => {
  throw new AppError('Quelque chose de précis a cassé', 400);
}));

app.use(notFoundMiddleware);
app.use(errorMiddleware);
```

`errorMiddleware` logge les erreurs serveur (5xx) via `req.log.error` si
disponible, sinon `console.error`, et ne logge jamais les erreurs client
(4xx).

## Clé idempotente

Un double appui sur « Payer », une application mobile qui rejoue sa file hors
ligne, un proxy qui retente après un délai : la même écriture arrive deux fois.
Le client génère UNE clé par intention (pas par tentative) et l'envoie dans
l'en-tête `Idempotency-Key` à chaque tentative. Le serveur exécute la première ;
les suivantes reçoivent la réponse conservée, avec l'en-tête
`Idempotent-Replay: true`, sans rien refaire.

```js
const { idempotencyMiddleware } = require('@astratra/core');

app.use('/api', authenticate); // AVANT : l'identité doit être vérifiée
app.use('/api', idempotencyMiddleware({
  store,                                  // voir « Le store » ci-dessous
  ttlMs: 24 * 60 * 60 * 1000,             // durée de vie d'une clé (défaut 24 h)
  identify: (req) => req.user?.id ?? null // identité STABLE : le compte, jamais le jeton
}));
```

Hors HTTP, le même moteur :

```js
const { createIdempotency } = require('@astratra/core');
const once = createIdempotency({ store, ttlMs: 60 * 60 * 1000 });
const { replayed, result } = await once.run(
  { scope: [accountId], key, payload: order },
  () => charge(order)
);
```

### Les décisions encodées, chacune testée

| Situation | Réponse |
|---|---|
| Pas d'en-tête, ou méthode de lecture | rien ne change, la requête passe |
| Clé jamais vue | exécutée, la réponse est retenue AVANT d'être envoyée |
| Même clé, même corps, déjà terminée | réponse conservée, rien n'est refait |
| Même clé, première encore en cours (requêtes simultanées) | `409` |
| Même clé, corps différent | `422` — jamais la réponse d'une autre demande |
| Réponse hors 2xx, ou exception | clé libérée : la tentative suivante s'exécute vraiment |
| Clé expirée pas encore purgée par le store | libérée puis réclamée, pas de faux « en cours » |
| Clé invalide (hors `[A-Za-z0-9_-]{8,128}`) | `400` |
| Store indisponible | `503` par défaut ; `onStoreError: 'allow'` laisse passer sans garde |

- **La réclamation est atomique.** L'enregistrement est inséré « s'il
  n'existe pas » AVANT l'exécution : c'est cette insertion qui départage deux
  requêtes simultanées, jamais une lecture suivie d'une écriture.
- **L'appelant fait partie de la clé.** `identify` est obligatoire. Prenez un
  identifiant VÉRIFIÉ (compte authentifié, ou jeton vérifié dans `identify`) :
  un identifiant simplement décodé permet de se faire passer pour un autre et
  de récupérer sa réponse. `null` place l'appel dans un espace anonyme commun,
  où seuls la clé et le corps séparent les appelants.
- **Le corps est comparé sans condition**, avec un hachage insensible à
  l'ordre des propriétés.
- **La réponse est stockée telle quelle** pendant `ttlMs`. Ne montez pas le
  middleware sur une route qui renvoie un secret (jeton de session, code de
  récupération) : il resterait en clair dans le store.

### Le store

Trois méthodes, pour n'importe quelle base :

```js
{
  acquire(id, entry),          // insertion ATOMIQUE si absent -> { acquired, record }
  complete(id, token, response), // passe à « done », seulement si le jeton de réclamation correspond
  release(id, token)             // supprime, seulement si le jeton correspond
}
```

MongoDB : `_id` unique + `insertOne` (erreur 11000 = déjà présent, relire),
index TTL sur `expiresAt`, `updateOne({ _id, token })`, `deleteOne({ _id, token })`.
Redis : `SET id entry NX PX ttl`. SQL : `INSERT … ON CONFLICT DO NOTHING`.
Le conditionnement par `token` n'est pas décoratif : sans lui, une tentative
lente qui libère une clé expirée efface la réclamation toute neuve d'une autre,
et les deux s'exécutent.

`createMemoryIdempotencyStore()` sert aux tests : il n'est ni persistant ni
partagé entre instances.

### Ce que ce module ne fait pas

- Une requête dont le processus meurt en cours d'exécution laisse sa clé
  « en cours » jusqu'à expiration : on préfère un `409` à un double paiement.
- Il ne protège pas les webhooks d'un prestataire de paiement : voir
  `@astratra/payments`, qui les reconnaît par l'identifiant d'événement.

## Tests

```bash
npm test --workspace @astratra/core
```
