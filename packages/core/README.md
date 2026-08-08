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
  loadEnv                // (schema) => lit process.env avec valeurs par défaut/requis/transform/validate
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

## Tests

```bash
npm test --workspace @astratra/core
```

20 tests, aucune base de données ni réseau requis.
