# Clinic Demo

Mini API Express de clinique construite comme application consommatrice des
packages Astratra locaux.

## Ce qui a ete ecrit a la main

- Trois utilisateurs de demo en memoire : admin, doctor, patient.
- Les routes metier minimales : `POST /auth/login`, `GET /me`,
  `GET /appointments`, `GET /admin/patients`.
- Un petit jeu de donnees d'exemple pour les rendez-vous.
- Les tests d'integration Supertest qui prouvent l'assemblage.

## Ce qui vient des packages Astratra

- Auth JWT entrante et injection de `req.user` :
  `createAuthMiddleware` depuis `@astratra/security`.
- RBAC : `authorizeRoles` depuis `@astratra/security`.
- Rate limiting API et login : `createApiLimiter` et `createLoginLimiter`
  depuis `@astratra/security`.
- WAF : `createWafMiddleware` depuis `@astratra/security`.
- Format de reponse des routes : `apiResponse` depuis `@astratra/core`.
- Request id, 404 et erreurs Express : `requestIdMiddleware`,
  `notFoundMiddleware`, `errorMiddleware` depuis `@astratra/core`.
- Audit des routes : commande `astratra audit:routes` depuis
  `@astratra/tooling`.

## Commandes

```bash
npm install
npm test --workspace=clinic-demo
npm run audit:routes --workspace=clinic-demo
```

## Passer a une vraie persistance

La demo garde ses stores en memoire pour rester simple a lancer, mais le
contrat est interchangeable avec `@astratra/store-mongo`.

```js
const mongoose = require('mongoose');
const { createMongoUsersStore, createMongoSettingsStore } = require('@astratra/store-mongo');

await mongoose.connect(process.env.MONGODB_URI);

const usersStore = createMongoUsersStore({
  connection: mongoose.connection,
  collection: 'clinic_users'
});

const settingsStore = createMongoSettingsStore({
  connection: mongoose.connection,
  collection: 'clinic_settings'
});
```

Dans l'assemblage de l'app, remplace le store memoire :

```js
// avant
usersStore: createMemoryUsersStore()

// apres
usersStore: createMongoUsersStore({ connection: mongoose.connection })
```

La connexion reste geree par l'application. Si l'adapter est cree avec
`uri`, il ouvre sa propre connexion et `disconnect()` la ferme.
