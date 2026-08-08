# @astratra/store-mongo

Adapters MongoDB/Mongoose reels pour les stores `usersStore` et
`settingsStore` attendus par `@astratra/saas-kit`.

Le package ne change pas `saas-kit` : il fournit juste une implémentation
persistante du même contrat que les stores mémoire de développement.

## Installation

```bash
npm install @astratra/store-mongo mongoose
```

`mongoose` est une dependance peer optionnelle du package. En pratique, une
application qui utilise déjà MongoDB garde sa propre dépendance et sa propre
connexion.

## Utilisateurs

```js
const mongoose = require('mongoose');
const { createMongoUsersStore } = require('@astratra/store-mongo');

await mongoose.connect(process.env.MONGODB_URI);

const usersStore = createMongoUsersStore({
  connection: mongoose.connection,
  collection: 'app_users'
});
```

Le schema est volontairement permissif : `email` et `role` sont connus, mais
`strict: false` laisse passer les champs métier de l'application consommatrice
comme `name`, `avatar`, `tenantId` ou `clinicId`.

Par défaut, `email` a un index unique. Pour désactiver cette contrainte :

```js
const usersStore = createMongoUsersStore({
  connection: mongoose.connection,
  uniqueEmail: false
});
```

## Parametres

```js
const { createMongoSettingsStore } = require('@astratra/store-mongo');

const settingsStore = createMongoSettingsStore({
  connection: mongoose.connection,
  collection: 'app_settings'
});

await settingsStore.set('timezone', 'Europe/Paris');
const allSettings = await settingsStore.getAll();
```

`settingsStore` stocke chaque réglage sous forme `{ key, value }`, avec
`value` en `Schema.Types.Mixed`.

## Avec `@astratra/saas-kit`

```js
const { createSaasApp } = require('@astratra/saas-kit');
const {
  createMongoSettingsStore,
  createMongoUsersStore
} = require('@astratra/store-mongo');

const app = createSaasApp({
  usersStore: createMongoUsersStore({ connection: mongoose.connection }),
  settingsStore: createMongoSettingsStore({ connection: mongoose.connection }),
  notify,
  verifyPassword
});
```

Les méthodes retournent des objets JavaScript simples via Mongoose `.lean()`
ou `.toObject()`, jamais des documents Mongoose vivants.

## Cycle de vie de connexion

Chemin recommandé : passer une `connection` déjà ouverte par l'application.
Dans ce mode, l'adapter ne ferme pas MongoDB.

```js
const usersStore = createMongoUsersStore({ connection: mongoose.connection });
await usersStore.disconnect(); // no-op pour une connexion injectée
```

Pour un script ou un petit service autonome, l'adapter peut ouvrir sa propre
connexion avec `uri`. Dans ce cas, `disconnect()` ferme cette connexion.

```js
const usersStore = createMongoUsersStore({
  uri: process.env.MONGODB_URI
});

// ...
await usersStore.disconnect();
```

## Tests

```bash
npm test --workspace @astratra/store-mongo
```

Les tests utilisent `mongodb-memory-server`, donc aucune instance MongoDB
externe n'est requise. Au premier lancement, le binaire MongoDB peut être
téléchargé par `mongodb-memory-server`.
