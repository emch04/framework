# @astratra/saas-kit

Starter backend réutilisable pour démarrer une nouvelle API SaaS avec les
packages Astratra.

`createSaasApp(options)` retourne une app Express avec des routes
génériques auth, users, settings, notifications et dashboard. Il assemble :

- `@astratra/core` pour les request IDs, le format de réponse API, le 404 et
  la gestion d'erreurs.
- `@astratra/security` pour le WAF, le rate limiting, l'auth JWT,
  l'autorisation par rôle, et le service WebAuthn optionnel.
- `@astratra/ai` en dépendance du package pour qu'un projet puisse composer
  des fonctionnalités IA à côté du starter, sans que le kit n'impose de
  routes IA métier.

## Démarrage rapide

```js
const { createSaasApp } = require('@astratra/saas-kit');

const app = createSaasApp({
  jwtSecret: process.env.JWT_SECRET,
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
sécurité que la mini-app de démo : request id, parseur JSON, WAF, limiteur
API, limiteur de login pour `/auth`, auth JWT pour les modules protégés,
puis 404 et gestion d'erreurs.

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
