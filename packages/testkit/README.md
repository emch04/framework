# @astratra/testkit

Trois outils pour des tests qui ne touchent jamais à la vraie base :

1. une **base jetable** (MongoDB ou Postgres dans un conteneur Docker) ;
2. de **fausses données réalistes par pays**, reproductibles par graine ;
3. un **garde-fou** qui refuse toute URI de base qui ressemble à de la production.

À installer en `devDependency`. Dépendances : `@faker-js/faker` 10 (MIT, à
l'exécution) et `@babel/plugin-transform-modules-commonjs` (MIT, pour le
préréglage Jest ci-dessous) ; `@testcontainers/mongodb` et/ou
`@testcontainers/postgresql` (MIT, optionnelles, à n'ajouter que pour le moteur
utilisé — elles apportent `testcontainers`). Node ≥ 22.22 (exigence de
testcontainers 12).

### Avec Jest

`@faker-js/faker` 10 n'existe qu'en module ES (les versions antérieures à 10.5
ont une faille d'exécution de code par `helpers.fake`). Node le charge sans
réglage par `require()`, mais pas le chargeur de Jest en CommonJS. Le paquet
fournit un préréglage qui fait convertir faker, et lui seul, par babel-jest :

```json
{ "jest": { "preset": "@astratra/testkit" } }
```

Si le projet a déjà son propre `transform`, reprends les deux réglages de
`jest-preset.js` (le `transform` babel-jest et le `transformIgnorePatterns`).
Autre voie, sans préréglage : Node ≥ 24.9 et
`NODE_OPTIONS=--experimental-vm-modules jest`.

## Base jetable

```js
const { startMongo, startPostgres, isDockerAvailable } = require('@astratra/testkit');

let db;
beforeAll(async () => {
  db = await startMongo({ database: 'app_test' }); // image mongo:8, replica set à un nœud
  process.env.MONGODB_URI = db.uri;                    // mongodb://127.0.0.1:PORT/app_test?directConnection=true
}, 120_000);
afterAll(() => db.stop());
```

`startPostgres()` (image `postgres:17-alpine`) rend `{ uri, stop }` de la même
façon. Si Docker est absent, `isDockerAvailable()` renvoie `false` : saute la
suite proprement (`const suite = isDockerAvailable() ? describe : describe.skip`).
Le conteneur démarre sur un port aléatoire, l'URI obtenue est elle-même passée
au garde-fou, et un conteneur dont l'URI serait refusée est arrêté aussitôt.

## Fausses données par pays

```js
const { createFakeData } = require('@astratra/testkit');

const data = createFakeData({ country: 'CD', seed: 42 });
data.person();            // { firstName, lastName, birthDate, email, phone: '+243 81 234 5678', address, … }
data.people(30, { minAge: 6, maxAge: 12 });
data.organization();
data.faker;               // l'instance faker graînée, pour le reste
```

Pays : `CD` (RDC, listes écrites ici car faker n'a pas de locale), `FR`, `BE`,
`CH`, `CA`, `SN`, `US`, `GB`, `GH`, `NG`, `ZA`, `IN`, `ES`, `MX`, `PT`, `BR`,
`DE`, `IT`, `JP`, `KR` (`supportedCountries()`). Noms et adresses suivent la
locale de faker ; les téléphones suivent le plan de numérotation du pays.

- **Reproductible** : même pays + même graine = même suite, à l'octet près. La
  date de référence des âges est fixe (1er janvier 2026), sinon la graine ne
  reproduirait rien d'une année à l'autre.
- **Sans risque** : les e-mails sont en `@example.test` (domaine réservé).
- La géographie n'est pas toujours cohérente (une ville et une région tirées
  indépendamment) : ce sont des données de test, pas un annuaire.

## Garde-fou

```js
const { assertSafeTestDatabaseUri } = require('@astratra/testkit');

assertSafeTestDatabaseUri(process.env.MONGODB_URI); // lance UnsafeTestDatabaseError, avec .reason
```

Refusé, dans l'ordre : `NODE_ENV=production` ; hébergeur géré (Atlas, RDS,
Supabase, Neon… — **même listé**) ; schéma `mongodb+srv` ; « prod »,
« production » ou « live » dans l'hôte ou le nom de base ; hôte distant (ni
boucle locale, ni `.test`/`.localhost`, ni nom de service sans point) sauf s'il
figure dans `allowRemoteHosts` **et** que la base porte « test » dans son nom ;
URI identique à `MONGODB_URI`/`DATABASE_URL`… de l'environnement sans nom de base
marqué test. Appelle-le au début de ton `globalSetup` : une suite qui vide des
collections ne doit jamais découvrir trop tard où elle est branchée.

## Limite

Le test de conteneurs réel de ce paquet n'est exécuté que si un démon Docker
répond ; sinon il est ignoré (les doublures testent le reste du chemin).
