# @astratra/saas-kit

Starter backend réutilisable pour démarrer une nouvelle API SaaS avec les
packages Astratra.

`createSaasApp(options)` retourne une app Express avec des routes
génériques auth, users, settings, notifications et dashboard. Il assemble :

- `@astratra/core` pour les request IDs, le format de réponse API, le 404 et
  la gestion d'erreurs.
- `@astratra/security` pour les primitives JWT/RBAC, le rate limiting, une
  CSP restrictive par défaut, le WAF heuristique et le service WebAuthn
  optionnel.
- `@astratra/ai` en dépendance du package pour qu'un projet puisse composer
  des fonctionnalités IA à côté du starter, sans que le kit n'impose de
  routes IA métier.

## Démarrage rapide

```js
const { createSaasApp } = require('@astratra/saas-kit');

const app = createSaasApp({
  jwtSecret: process.env.JWT_SECRET,
  jwtAlgorithms: ['HS256'],
  jwtIssuer: 'mon-app',
  jwtAudience: 'mon-api',
  usersStore,
  settingsStore,
  verifyPassword: async (user, password) => passwordService.verify(user, password),
  notify: async (userId, notification) => notificationService.send(userId, notification),
  roles: {
    adminRoles: ['owner', 'admin']
  }
});

app.listen(3000);
```

Ça donne immédiatement à un nouveau projet une API fonctionnelle :

- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `GET /auth/me`
- `GET /users`
- `GET /users/:id`
- `POST /users`
- `PATCH /users/:id`
- `GET /settings`
- `PATCH /settings/:key`
- `POST /notifications/send`
- `GET /dashboard/summary`

Toutes les routes protégées suivent le même ordre de middlewares de
sécurité que la mini-app de démo : request id, parseur de cookies, CSP
(`default-src 'none'` par défaut, adapté à une API JSON — surchargeable via
`options.csp`), parseur JSON, WAF heuristique, limiteur API, limiteur de
login pour `/auth`, auth JWT (cookie ou `Authorization: Bearer`) pour les
modules protégés, CSRF pour les routes mutantes, puis 404 et gestion
d'erreurs.

`jwtAlgorithms` vaut `['HS256']` par defaut. `jwtIssuer` et `jwtAudience` sont
optionnels, mais recommandes des qu'une app sort du simple developpement local.

## Session cookie HttpOnly, CSRF et révocation

`POST /auth/login` pose toujours un cookie `HttpOnly` (`astratra_session` par
défaut) en plus de renvoyer `{ token, user }` en JSON — le cookie sert les
clients web, le token JSON sert les clients API/mobile. Le nom, `sameSite`,
`secure`, `path`, `domain` et la durée de vie du cookie se configurent via
`options.cookie` :

```js
createSaasApp({
  // ...
  cookie: { name: 'ma_session', sameSite: 'strict' },
  csrf: { headerName: 'x-csrf-token' } // optionnel, défauts déjà sensés
});
```

Toutes les routes mutantes protégées (`/users`, `/settings`,
`/notifications`, `/dashboard`, `/auth/logout(-all)`, `/auth/webauthn/*`)
exigent un token CSRF (cookie non-`HttpOnly` `astratra_csrf` + header
`x-csrf-token`) **sauf** pour les clients authentifiés par `Authorization:
Bearer` (mobile/API — non exposés au CSRF) et `POST /auth/login`
(pas de session préexistante à protéger).

`POST /auth/logout` invalide immédiatement le JWT courant (via un
`revocationStore` en mémoire fourni par défaut — remplaçable par
`options.revocationStore` pour une prod multi-instance, ex. Redis).
`POST /auth/logout-all` invalide tous les JWT actifs de l'utilisateur, pas
seulement celui de la requête courante.

## Validation des entrées

`POST /auth/login`, `POST /users`, `PATCH /settings/:key` et
`POST /notifications/send` valident leur payload via
`validateMiddleware` (`@astratra/core`) et `express-validator` avant
d'appeler ton store — email au bon format, champs requis réellement présents
(pas juste "truthy"), longueurs raisonnables sur les champs texte libres
(titre, message). Une entrée invalide renvoie `400` avant même de toucher
`usersStore`/`settingsStore`/`notify`. Le kit ne valide que les champs qu'il
connaît lui-même — le reste du payload (champs propres à ton store) passe
tel quel, sans schéma imposé.

## Adapters requis

Une vraie application en production doit injecter ses propres adapters. Le
kit ne choisit ni base de données, ni algorithme de hash de mot de passe, ni
canal de notification, ni rôles spécifiques à un produit.

```js
const usersStore = {
  findByEmail(email) {},
  findById(id) {},
  create(userData) {},
  list({ role, limit, offset }) {},
  update(id, patch) {}
};

const settingsStore = {
  get(key) {},
  set(key, value) {},
  getAll() {}
};
```

`verifyPassword(user, password)` est également injecté, pour que
l'application consommatrice garde la main sur le hashing et les règles de
credentials. `notify(userId, { title, message, channel })` est injecté pour
que la livraison puisse être un email, un push, une notification in-app, ou
tout autre canal.

Les routes WebAuthn ne sont montées que si `webauthnStore` est fourni. Le
store est transmis au service WebAuthn de `@astratra/security`.

## Stores mémoire — développement uniquement

Le package exporte :

```js
const {
  createMemoryUsersStore,
  createMemorySettingsStore
} = require('@astratra/saas-kit');
```

Ces stores servent uniquement au développement local, aux démos et aux
tests. Les données restent en mémoire process, ne sont pas persistantes, et
sont perdues au redémarrage. À remplacer avant toute utilisation en
production.

Si `usersStore` ou `settingsStore` sont omis, `createSaasApp` utilise ces
stores mémoire dev-only pour que le starter démarre immédiatement.
`verifyPassword` et `notify` sont toujours injectés par l'app
consommatrice ; le kit ne fournit ni algorithme de mot de passe ni
comportement de livraison de notification.

Si `revocationStore` est omis, `createSaasApp` utilise de la même façon
`createMemoryRevocationStore()` de `@astratra/security` (pas mémorisé entre
process, ni partagé entre instances). Pour une prod multi-instance, fournis
ton propre store implémentant la même interface (Redis, etc.) via
`options.revocationStore`.

## Tableau de bord

`GET /dashboard/summary` retourne uniquement des stats génériques de
plateforme :

```json
{
  "userCount": 2,
  "roleBreakdown": {
    "owner": 1,
    "member": 1
  }
}
```

Les KPI spécifiques au projet doivent être ajoutés par l'app consommatrice,
en dehors de ce kit.

## Tests

```bash
npm test --workspace @astratra/saas-kit
```

Les tests d'intégration utilisent `node --test` et exercent l'app Express
sans ouvrir de vrai listener réseau, ce qui les rend exécutables dans des
sandboxes restreintes.
