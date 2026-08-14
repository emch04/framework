# Astratra — rate limiting Redis pour @astratra/security

## Contexte

`createApiLimiter`, `createLoginLimiter` et `createAccountLimiter` utilisaient
le store memoire par defaut de `express-rate-limit`. En deploiement
multi-instance, chaque processus Node a donc ses propres compteurs ; un
attaquant peut obtenir `max` tentatives par instance au lieu de `max` au
total.

`@astratra/ai` resout deja le probleme equivalent pour les quotas IA avec un
lien Redis optionnel et non bloquant. Ce spec applique le meme principe au
rate limiting.

## Changement

Ajouter `options.redisUrl` et `options.store` aux trois constructeurs de
limiters. `express-rate-limit` supporte deja une interface `store`
pluggable ; lorsque `redisUrl` est fourni, Astratra utilise le store officiel
`rate-limit-redis` au lieu de reimplementer la logique Redis.

```js
const { createApiLimiter } = require('@astratra/security');

const limiter = createApiLimiter({
  redisUrl: process.env.REDIS_URL
});
```

Comportement attendu :

- Sans `redisUrl`, le comportement memoire reste identique.
- Si la connexion Redis echoue au demarrage, l'application continue avec le
  store memoire. Un probleme Redis ne doit pas bloquer l'app.
- Si `options.store` est fourni, il est prioritaire sur `redisUrl`, pour
  permettre au consommateur d'injecter son propre store compatible
  `express-rate-limit`.
- `redis` et `rate-limit-redis` sont des peer dependencies optionnelles,
  declarees avec `peerDependenciesMeta.optional = true`.

## Tests

- Le comportement memoire existant ne change pas lorsque `redisUrl` et
  `store` sont absents.
- Un test verifie que `createApiLimiter({ redisUrl })` construit un limiter
  avec store Redis lorsque `redis` et `rate-limit-redis` sont mockes.
- Un test verifie qu'une erreur de connexion Redis retombe sur le store
  memoire sans exception non geree.

## Hors perimetre

- Aucun changement au lien Redis de `@astratra/ai`.
- Aucun changement au contrat `onBlocked` de `createLoginLimiter`.
