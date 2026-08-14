# @astratra/store-postgres

Adapters PostgreSQL réels pour les stores `usersStore` et `settingsStore`
attendus par `@astratra/saas-kit` — même contrat que `@astratra/store-mongo`,
moteur différent. Les deux packages sont indépendants ; un projet Astratra
choisit celui qui correspond à sa base de données.

Le package ne change pas `saas-kit` : il fournit juste une implémentation
persistante du même contrat que les stores mémoire de développement.

## Installation

```bash
npm install @astratra/store-postgres pg
```

`pg` est une dépendance peer optionnelle du package. En pratique, une
application qui gère déjà sa propre connexion Postgres garde son propre
`Pool`.

## Utilisateurs

```js
const { Pool } = require('pg');
const { createPostgresUsersStore } = require('@astratra/store-postgres');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const usersStore = createPostgresUsersStore({
  pool,
  usersTable: 'app_users'
});
```

La table est créée automatiquement au premier usage (`CREATE TABLE IF NOT
EXISTS`) avec un schéma volontairement souple : `email` et `role` sont des
colonnes indexées pour les requêtes rapides, mais l'objet utilisateur complet
(y compris tout champ métier propre à l'application — `name`, `avatar`,
`tenantId`...) est stocké tel quel dans une colonne `data JSONB`. Aucun schéma
SQL rigide à maintenir côté application.

Par défaut, `email` a un index unique. Pour désactiver cette contrainte :

```js
const usersStore = createPostgresUsersStore({
  pool,
  uniqueEmail: false
});
```

## Paramètres

```js
const { createPostgresSettingsStore } = require('@astratra/store-postgres');

const settingsStore = createPostgresSettingsStore({
  pool,
  settingsTable: 'app_settings'
});

await settingsStore.set('timezone', 'Europe/Paris');
const allSettings = await settingsStore.getAll();
```

`settingsStore` stocke chaque réglage sous forme `{ key, value JSONB }`.

## Avec `@astratra/saas-kit`

```js
const { createSaasApp } = require('@astratra/saas-kit');
const {
  createPostgresSettingsStore,
  createPostgresUsersStore
} = require('@astratra/store-postgres');

const app = createSaasApp({
  usersStore: createPostgresUsersStore({ pool }),
  settingsStore: createPostgresSettingsStore({ pool }),
  notify,
  verifyPassword
});
```

Les méthodes retournent toujours des objets JavaScript simples (jamais une
ligne `pg` brute) : `{ ...donnéesJSONB, id }`.

## Migrations

Pas un DSL, pas de CLI, pas d'introspection de schéma — un runner minimal
et honnête : tu lui donnes du SQL brut dans l'ordre, il applique une seule
fois chaque migration non encore vue (suivi par `id` dans une table de
suivi), chacune dans sa propre transaction, annulée en cas d'échec.

```js
const { createPostgresMigrationRunner } = require('@astratra/store-postgres');

const runner = createPostgresMigrationRunner({ pool });

await runner.run([
  { id: '2026-01-01-add-name', up: (client) => client.query('ALTER TABLE app_users ADD COLUMN name TEXT') },
  { id: '2026-01-15-index-role', up: (client) => client.query('CREATE INDEX IF NOT EXISTS app_users_role_idx ON app_users (role)') }
]);
```

Rejoue `run()` avec la même liste (plus les nouvelles migrations ajoutées
au fil du temps) à chaque déploiement — les `id` déjà appliqués sont
ignorés. `appliedIds()` retourne l'historique. Pas de `down()` : ce runner
ne fait qu'avancer, un rollback de schéma se fait via une nouvelle migration
qui défait l'ancienne.

## Cycle de vie de connexion

Chemin recommandé : passer un `pool` déjà géré par l'application. Dans ce
mode, l'adapter ne ferme jamais ce pool.

```js
const usersStore = createPostgresUsersStore({ pool });
await usersStore.disconnect(); // no-op pour un pool injecté
```

Pour un script ou un petit service autonome, l'adapter peut créer et gérer
son propre `Pool` via `connectionString`. Dans ce cas, `disconnect()` ferme
réellement ce pool.

```js
const usersStore = createPostgresUsersStore({
  connectionString: process.env.DATABASE_URL
});

// ...
await usersStore.disconnect();
```

## Tests

```bash
npm test --workspace @astratra/store-postgres
```

Les tests utilisent `pg-mem` (moteur SQL compatible Postgres en mémoire),
donc aucune instance PostgreSQL externe n'est requise.
