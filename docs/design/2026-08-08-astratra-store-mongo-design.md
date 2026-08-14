# Astratra — @astratra/store-mongo (adapter de persistance reel, V0)

## Contexte

Les adapters `usersStore` et `settingsStore` attendus par
`@astratra/saas-kit` etaient uniquement fournis en memoire pour le
developpement. C'etait le plus gros manque avant un usage reel. Ce spec
ajoute un premier adapter utilisable en production : MongoDB/Mongoose,
coherent avec une pile Node/MongoDB courante, donc sans nouvelle charge
operationnelle majeure pour ce projet.

C'est un **nouveau package**, pas une modification de `saas-kit` lui-meme.
Le principe reste le meme partout dans Astratra : `saas-kit` ne sait pas
quelle base de donnees se cache derriere ses adapters. `@astratra/store-mongo`
est seulement une implementation concrete de l'interface deja definie.

## Interfaces a implementer

D'apres `packages/saas-kit/src/app.js` et `src/utils.js`, `createSaasApp`
attend ces deux contrats :

```js
usersStore: {
  findByEmail(email): Promise<user|null>
  findById(id): Promise<user|null>
  create(userData): Promise<user>
  list({ role, limit, offset }): Promise<user[]>
  update(id, patch): Promise<user|null>
}

settingsStore: {
  get(key): Promise<value>
  set(key, value): Promise<void>
  getAll(): Promise<{ [key]: value }>
}
```

## Package : @astratra/store-mongo

Dependance : `mongoose` en peer dependency optionnelle. Dans le cas courant,
l'application consommatrice a deja Mongoose et sa connexion ouverte ; le
package ne force donc pas une version precise.

### `createMongoUsersStore(options)`

```js
const { createMongoUsersStore } = require('@astratra/store-mongo');

const usersStore = createMongoUsersStore({
  connection: mongoose.connection,   // ou options.uri pour connecter en interne
  collection: 'astratra_users'       // optionnel, defaut 'astratra_users'
});
```

- Construit un schema Mongoose permissif : `{ email: String, role: String }`
  avec `strict: false`, pour laisser passer les champs metier du projet
  consommateur (`name`, `avatar`, `tenantId`, etc.) sans imposer une forme
  utilisateur unique.
- `findById` et `update` acceptent un ObjectId Mongo sous forme de string et
  retournent `null` pour un id invalide ou absent, afin de garder le meme
  comportement que le store memoire.
- Tous les utilisateurs retournes sont des objets JavaScript simples
  (`.toObject()` ou `.lean()`), jamais des documents Mongoose vivants.
- `list({ role, limit, offset })` utilise `.find(...).skip().limit()` ; le
  filtre `role` n'est applique que lorsqu'il est fourni.
- `create` laisse MongoDB rejeter les emails dupliques quand l'index unique
  est active (`options.uniqueEmail`, defaut `true`).

### `createMongoSettingsStore(options)`

Memes options `connection` et `collection` (defaut `astratra_settings`).
Collection simple : `{ key: String (unique), value: Schema.Types.Mixed }`.
`get`, `set` et `getAll` correspondent directement a
`findOne`, `findOneAndUpdate({ upsert: true })` et `find`.

## Cycle de vie de connexion

Le package n'ouvre sa propre connexion Mongo que si `options.uri` est fourni.
Dans ce cas, il gere `mongoose.createConnection(uri)` et expose
`store.disconnect()`. Le chemin recommande reste de passer une `connection`
deja geree par l'application consommatrice. Astratra ne prend pas possession
du cycle de vie de la base par defaut.

## Tests

Les tests utilisent `mongodb-memory-server` pour eviter une instance MongoDB
externe. Couverture attendue :

- creation, lecture, mise a jour et retour d'objets simples pour les users ;
- filtrage par role et pagination dans `list` ;
- rejet d'un email duplique ;
- `get`, `set`, `getAll` pour les settings ;
- `findById` et `update` qui retournent `null` pour un id inexistant ou
  invalide ;
- mode connexion injectee et mode connexion geree par `uri`.

## Preuve d'integration

Le README de `examples/clinic-demo` documente comment remplacer les stores
memoire par `createMongoUsersStore({ connection })` et
`createMongoSettingsStore({ connection })`. Le code de demo reste volontairement
simple, mais le contrat d'adapter est prouve interchangeable.

## Hors perimetre

- Pas d'adapter Postgres/SQL dans ce passage.
- Pas d'outillage de migration ou de seed.
- Pas de modification de `saas-kit`, qui accepte deja tout adapter conforme.
