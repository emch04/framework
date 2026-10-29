# @astratra/gouvernance

[English](README.md) | [Français](README.fr.md)

Les actions d'une IA sur les données, gouvernées. L'IA ne modifie jamais une base : elle
**propose** une action ; le pack calcule l'**aperçu exact** (lignes et valeurs touchées), applique
les **niveaux d'autonomie**, vérifie la **validation humaine signée**, **revérifie** les données au
moment d'écrire et **exécute tout ou rien**, avec un **journal d'audit** complet. Node ≥ 20,
CommonJS, MIT.

Le pack s'appuie sur [`@astratra/conscience`](../conscience/README.fr.md) : son gouverneur
fournit l'arrêt d'urgence, le journal d'audit et les budgets calendaires (quotas). Aucun modèle de
langage n'est consulté : la même proposition et les mêmes règles donnent toujours la même décision.

```sh
npm install @astratra/gouvernance @astratra/conscience
```

| Entrée | Contenu |
|---|---|
| `@astratra/gouvernance` | Contrat, niveaux d'autonomie, cycle de vie, validations signées, magasin et connecteur en mémoire |
| `@astratra/gouvernance/postgres` | Connecteur PostgreSQL et magasin des propositions (un `Pool` de `pg`, aucune connexion ouverte par le pack) |
| `@astratra/gouvernance/mongo` | Connecteur MongoDB et magasin des propositions (le `Db` et le `MongoClient` du pilote officiel, jamais importé) |

## Le cycle

1. **Proposer.** L'IA donne une action fermée, jamais du SQL ni une requête libre.
2. **Aperçu.** Le connecteur lit les lignes qui correspondent maintenant ; pour chacune : clé,
   valeurs avant et après des colonnes touchées, et une empreinte de version.
3. **Niveau.** Les règles disent si l'action est libre, libre avec avis, à valider ou interdite.
4. **Validation.** Une personne valide avec sa passkey (Face ID, Touch ID…) ; le service de
   validation signe. L'application vérifie les deux preuves.
5. **Revérification.** Au moment d'écrire, les lignes sont verrouillées et relues ; une ligne
   changée, supprimée ou apparue depuis l'aperçu arrête tout (`stale_data`).
6. **Exécution.** Tout ou rien, dans une transaction ; les valeurs écrites sont exactement celles
   de l'aperçu.
7. **Audit.** Chaque étape est écrite au journal du gouverneur **avant** d'agir ; un journal
   illisible empêche d'agir. Le journal garde des codes et des nombres, jamais de valeurs.
8. **Annulation.** Une action exécutée (sauf une suppression) se défait d'un geste humain, pendant
   un délai, si les lignes n'ont pas changé depuis.

## Démarrage

```js
const { createGovernor, createPostgresGovernorStore, postgresGovernorSchema } = require('@astratra/conscience/governor');
const { createDataGovernance } = require('@astratra/gouvernance');
const { createPostgresConnector, createPostgresGovernanceStore, postgresGovernanceSchema } = require('@astratra/gouvernance/postgres');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(postgresGovernorSchema());
await pool.query(postgresGovernanceSchema());           // dans la MÊME base que les données

const governorStore = createPostgresGovernorStore(pool);
const governor = createGovernor({ budgets: { perCycle: 1, perAgent: 10, perOrganisation: 50 } }, { store: governorStore });

const governance = createDataGovernance({
  governor,                                           // arrêt d'urgence
  auditStore: governorStore,                          // journal d'audit
  store: createPostgresGovernanceStore(pool),         // propositions
  connectors: {
    shop: createPostgresConnector({ pool, resources: {
      products: { table: 'shop.products', key: 'id', writable: ['price', 'stock'], filterable: ['promo', 'category'],
                  tags: ['catalogue'], amount: 'price', maxRows: 200, operations: ['update'] }
    } })
  },
  rules: [
    { id: 'stock', level: 'free_with_notice', match: { resources: ['products'] }, quota: { perDay: 30 } },
    { id: 'prices', level: 'validation', match: { resources: ['products'], amountAbove: 0 } }
  ],
  trust: {
    keys: [{ keyId: 'key-2026-11', publicKey: process.env.VALIDATION_PUBLIC_KEY }],   // Ed25519, SPKI en base64
    approvers: [{ id: 'owner-1', credentials: [{ id: 'credential-id', publicKey: 'MFkw…' }] }],
    rpId: 'validation.example.com', origins: ['https://validation.example.com']
  }
});

// L'IA propose une hausse de 5 % hors promotions.
const view = await governance.propose({
  organisationId: 'org-1',
  agent: { id: 'assistant', model: 'model-2026-10', instructions: 'consigne-3f2a' },
  requestedBy: { kind: 'human', id: 'user-7' },                     // fourni par l'application, jamais par le modèle
  intent: { code: 'raise_prices', confidence: 0.86 },
  actions: [{ connector: 'shop', resource: 'products', op: 'update',
              where: { promo: false, category: 'kitchen' }, set: { price: { multiply: 1.05, round: 2 } } }],
  explanation: 'Hausse de 5 % hors promotions.'                      // texte de l'IA, hors empreinte, jamais interprété
});
// view.status : 'awaiting_validation' ; view.proposal : à envoyer au service de validation.

// Plus tard, la validation signée revient :
const done = await governance.applyValidation(validation, { organisationId: 'org-1' });
// done.status : 'executed', 'stale' (données changées), 'failed'… ; done.code dit pourquoi.
```

## Ressources

L'application déclare ce que l'IA peut toucher. Tout le reste est refusé avant même l'aperçu.

| Champ | Par défaut | Sens |
|---|---|---|
| `table` | obligatoire | Table (ou `schéma.table`) |
| `key` | obligatoire | Clé primaire, une colonne ou plusieurs ; jamais modifiable, jamais sensible |
| `writable` | `[]` | Colonnes que l'IA peut écrire |
| `filterable` | `[]` | Colonnes utilisables dans `where` (en plus de la clé) |
| `sensitive` | `[]` | Valeurs masquées dans la proposition envoyée (`{ "$masked": "…" }`, HMAC salé, sel gardé par l'application) |
| `tags` | `[]` | Étiquettes de données, pour les règles (`catalogue`, `finances`…) |
| `amount` | aucune | Colonne de montant : la somme des écarts compte pour `amountAbove` |
| `maxRows` | `100` | Au-delà : refus (`too_many_rows`), jamais d'aperçu tronqué |
| `operations` | `['update']` | `insert`, `update`, `delete` |
| `types` | `{}` | MongoDB : `{ _id: 'objectId', soldAt: 'date' }`, pour que l'aperçu soit du JSON (hexadécimal, ISO) et que l'écriture remette le bon type |

## Actions

```js
{ connector, resource, op: 'update', where: { id: { in: ['p1', 'p2'] } }, set: { price: 12, stock: { increment: -1 } } }
{ connector, resource, op: 'insert', values: { id: 'p5', label: 'Vase', price: 15 } }   // la clé est obligatoire
{ connector, resource, op: 'delete', where: { id: 'p4' } }
```

- `where` est obligatoire (jamais toute la table) : valeur simple (égalité), ou `eq`, `ne`, `gt`,
  `gte`, `lt`, `lte`, `in` (500 valeurs au plus), `isNull`. Les conditions s'additionnent (ET).
- `set` : une valeur simple, `{ increment }` ou `{ multiply, round? }` (décimales). L'aperçu montre
  la valeur obtenue ; c'est exactement elle qui sera écrite.
- 20 actions au plus par proposition, sur un seul connecteur (`mixed_connectors` sinon : le tout
  ou rien n'est possible que dans une base). Deux actions ne touchent pas la même ligne
  (`overlapping_actions`).

## Niveaux d'autonomie

| Niveau | Effet |
|---|---|
| `free` | Exécutée tout de suite, tracée |
| `free_with_notice` | Exécutée tout de suite, annulable (24 h par défaut, `undoWindowMs`) ; une suppression passe en `validation` |
| `validation` | Rien sans une validation humaine signée |
| `forbidden` | Jamais, même validée |

```js
{ id: 'night', level: 'validation', approvals: 1,
  match: { ops: ['update'], resources: ['products'], tags: ['catalogue'], agents: ['assistant'],
           rowsAbove: 10, amountAbove: 5000, when: { timeZone: 'Europe/Paris', days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' } },
  quota: { perDay: 20 } }
```

- Tous les critères présents doivent correspondre. **La règle la plus stricte l'emporte.** Une
  écriture qu'aucune règle ne couvre attend une validation.
- Les critères se lisent **par ressource, actions additionnées** : découper une grosse
  modification en petites actions ne fait pas passer sous `rowsAbove` ou `amountAbove`.
- `approvals` (1 à 5) : nombre de personnes distinctes exigé quand la règle donne `validation`.
- `quota.perDay` : au-delà, une action libre repasse en `validation` (`quota_exceeded`). Aussi
  `quotas: { perDay, timeZone, store }` pour toutes les actions libres d'une IA. Le compteur est le
  budget calendaire de la Conscience (`createMemoryToolBudgetStore`, `createPostgresToolBudgetStore`).
- **Règles distantes** (`remoteRules: async ({ organisationId, environment }) => ({ version, rules })`) :
  elles s'ajoutent aux règles locales, donc ne peuvent que **resserrer**. Source muette : les
  dernières règles lues. Jamais lues : tout ce qui écrit attend une validation
  (`remote_rules_unavailable`).
- Les règles sont **relues au moment d'exécuter** : une règle devenue `forbidden`, ou un nombre
  d'approbations relevé, s'applique à une proposition déjà validée.

## Validation signée

Deux preuves, que l'application vérifie elle-même :

1. **La passkey de la personne.** Le défi WebAuthn est
   `challengeFor({ propositionId, digest, decision, environment, approver, nonce })` (SHA-256 en
   base64url de ces champs, sérialisation stable). La présence **et** la vérification de
   l'utilisateur sont exigées. L'application la revérifie avec **sa** liste de clés publiques
   d'approbateurs.
2. **La signature Ed25519 du service de validation** sur toute la validation
   (`signValidation(validation, { privateKey, keyId })`). L'application ne garde que la clé
   publique : rien de secret chez elle.

```json
{
  "schema": "gouvernance-validation/1", "propositionId": "…", "digest": "…", "decision": "approve",
  "environment": "production",
  "approvals": [{ "approver": "owner-1", "credentialId": "…", "nonce": "…", "at": "…",
                  "webauthn": { "authenticatorData": "…", "clientDataJSON": "…", "signature": "…" } }],
  "issuedAt": "…", "expiresAt": "…", "keyId": "key-2026-11", "signature": "…"
}
```

Contrôles, dans cet ordre (code rendu en cas de refus) : signature (`bad_signature`,
`unknown_key`), proposition et empreinte recalculée sur **la copie de l'application**
(`wrong_proposal`, `proposal_modified`), environnement (`wrong_environment`), dates
(`expired` ; `maxAgeMs` 30 min, `skewMs` 30 s), puis chaque preuve humaine (`not_an_approver`,
`bad_human_proof`, `duplicate_approver`, `self_approval` quand `subject` est la personne qui a fait
la demande), puis le nombre (`not_enough_approvals`). Une validation ne sert qu'une fois
(`replayed`). Un service de validation compromis ne peut pas fabriquer une validation : il lui
manque la passkey.

- **Décisions** : `approve` (exécute), `decline` (refuse, sans preuve humaine exigée), `undo`
  (annule une action exécutée).
- **Mode hybride** : une passkey peut avoir son propre `rpId` et ses `origins` (la personne valide
  dans l'application elle-même) ; les deux preuves restent exigées.
- **Rotation** : plusieurs clés ; `notAfter` refuse une validation émise après le retrait d'une clé.

## Ce que voit le service de validation

`view.proposal` : la proposition canonique, empreinte comprise (`digest` = SHA-256 de tout le
reste). Les valeurs des colonnes `sensitive` y sont masquées, et l'empreinte est calculée sur la
forme masquée : le service peut la recalculer. Les versions de lignes sont des HMAC salés. Le sel
et les valeurs en clair restent dans le magasin de l'application. `explanation` (le texte de l'IA)
est hors empreinte.

## États

`ready` → `executing` → `executed` | `stale` | `failed` ; `awaiting_validation` → `executing` |
`declined` | `expired` | `refused` ; `executed` → `undoing` → `undone` (ou retour à `executed`
si l'annulation trouve des lignes changées). Une transition n'a qu'un gagnant, même à plusieurs
processus.

## PostgreSQL

- Isolation `REPEATABLE READ` par défaut (`isolation: 'serializable'` possible). À l'exécution :
  `SELECT … FOR UPDATE` avec le filtre d'origine (lignes verrouillées, fantômes visibles),
  comparaison des versions, écritures par clé (une ligne chacune), puis l'état de la proposition
  dans **la même transaction**, puis `COMMIT`. Une écriture concurrente (`40001`, `40P01`, `23505`)
  rend `stale_data` ; toute autre erreur annule tout et rend `failed`.
- Avec le magasin PostgreSQL dans la même base, une panne ne laisse jamais des données écrites
  sans l'état `executed`, ni l'inverse. Une proposition restée `executing` après une panne n'a
  rien écrit.
- `postgresGovernanceSchema({ prefix })` est idempotent ; `numeric` arrive en texte (`'10.50'`) et
  se compare comme un nombre à l'annulation.

## MongoDB

```js
const { MongoClient, ObjectId } = require('mongodb');
const { createMongoConnector, createMongoGovernanceStore, mongoGovernanceIndexes } = require('@astratra/gouvernance/mongo');

const client = await MongoClient.connect(process.env.MONGO_URL);   // avec mongoose : connection.getClient() et connection.db
const db = client.db();
await mongoGovernanceIndexes(db);                                   // dans la MÊME base que les données

const connector = createMongoConnector({ db, client, ObjectId, resources: {
  grades: { table: 'grades', key: '_id', writable: ['value'], filterable: ['student', 'subject'], types: { _id: 'objectId', student: 'objectId' } }
} });
const store = createMongoGovernanceStore(db);
```

- **Tout ou rien par une transaction** (`withTransaction`, lecture `snapshot`, écriture `majority`) : relecture du
  filtre d'origine, comparaison des versions, écritures par clé (un document chacune), puis l'état de la proposition
  dans la même transaction. Une erreur passagère fait rejouer le tout, comparaison comprise ; un conflit d'écriture ou
  une clé en double rend `stale_data` ; toute autre erreur (un validateur de la collection, par exemple) annule tout et
  rend `failed`.
- **Il faut un jeu de réplicas** (ou un cluster). Sans lui, `check()` rend `false` et l'exécution échoue sans rien
  écrire. `transactions: false` permet un serveur seul, mais **une seule écriture par proposition** (sinon
  `transactions_required`) : la mise à jour est filtrée par toute la ligne lue à l'aperçu ; l'état de la proposition
  est écrit juste après, pas dans la même opération.
- Les champs sont ceux du premier niveau du document (pas de chemin `a.b`). ObjectId, dates, Decimal128 et Long
  deviennent du texte dans l'aperçu ; un champ binaire est refusé.
- Le magasin garde chaque enregistrement en JSON : les valeurs masquées (`$masked`) ne deviennent jamais des clés de
  document.

## Autres fonctions

`expire({ organisationId })` passe en `expired` les propositions en attente dépassées (12 h par
défaut, `proposalTtlMs`). `get`, `list`, `verifyDigest`, `challengeFor` (pour faire signer dans
l'application). `defineResources`, `normalizeRules`, `decideLevel`, `verifyValidation`,
`createTrust`, `stableStringify`, `digestOf` sont exportées pour un service de validation qui
voudrait refaire les mêmes calculs.

## Tests

```sh
npm test
GOUVERNANCE_TEST_DATABASE_URL=postgresql://localhost/gouvernance_test npm test   # avec un vrai PostgreSQL
MONGO_TEST_URL=mongodb://localhost:27017/?replicaSet=rs0 npm test                  # un jeu de réplicas à vous
```

La base PostgreSQL doit finir par `_test` ; les tests créent et suppriment leur propre schéma `shop`. Sans
`MONGO_TEST_URL`, les tests MongoDB démarrent un jeu de réplicas en mémoire (`mongodb-memory-server`).

## Limites

- Les lectures de l'IA ne passent pas par ce pack.
- Une proposition ne touche qu'une base (pas de transaction entre deux bases).
- Une suppression ne s'annule pas.
- Si une action change une ligne de façon qu'elle entre dans le filtre d'une action suivante de la
  même proposition, l'exécution s'arrête (`stale_data`) : regrouper ces actions.
- Une ligne ajoutée par quelqu'un d'autre pendant la transaction elle-même (après sa première lecture) n'est pas vue
  en `REPEATABLE READ` ni dans une transaction MongoDB ; `isolation: 'serializable'` le couvre pour PostgreSQL.
