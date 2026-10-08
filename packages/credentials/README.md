# @astratra/credentials

Les clés de service — paiement, e-mail, IA — rangées **chiffrées dans ta base**
plutôt que dans un `.env` sur le serveur. Elles se saisissent depuis l'interface,
prennent effet en moins d'une minute, sans redémarrage et sans session SSH.

Le `.env` garde son rôle de secours : rien ne casse tant qu'aucune clé n'a été
saisie.

Ce package ne connaît ni ta base, ni ton chiffrement, ni tes fournisseurs. Tout
est injecté : le store, le cipher, le catalogue de clés, la règle qui protège
les valeurs sensibles, et la fonction qui envoie le code de déverrouillage.

## Le problème

Changer une clé Stripe ou une clé d'API obligeait à ouvrir une session SSH,
éditer un fichier, relancer le service. Trois occasions de se tromper, et un
secret en clair sur le disque du serveur.

## L'ordre, qui ne change jamais

1. une valeur **saisie dans l'interface** → déchiffrée et utilisée ;
2. une clé **explicitement débranchée** → rien, même si le `.env` en a une ;
3. **rien en base** → le `.env`, comme avant.

Le point 2 est le piège. Sans marqueur de débranchement, supprimer une clé la
ferait réapparaître par la variable d'environnement de secours — et on ne
saurait jamais si un service est vraiment débranché.

## Mise en place

```js
const { createFieldCipher } = require('@astratra/security');
const {
  createCredentialCatalog,
  createCredentialVault,
  createEnvHydrator,
  createMongoCredentialStore
} = require('@astratra/credentials');

// 1. Ce que l'interface a le droit de piloter. Jamais un champ libre :
//    sans catalogue, n'importe quel nom de variable pourrait être écrit en
//    base puis lu au démarrage.
const catalog = createCredentialCatalog({
  spaces: [
    {
      id: 'ai',
      label: 'Intelligence artificielle',
      hint: 'Interrogés dans cet ordre.',
      keys: [
        {
          key: 'GROQ_API_KEY',
          label: 'Groq',
          help: "Le premier fournisseur interrogé. Sans lui, on bascule sur le suivant.",
          where: 'console.groq.com → API Keys'
        }
      ]
    }
  ],
  // La serrure ne se range pas dans le coffre qu'elle ferme.
  reservedKeys: ['ENCRYPTION_KEY', 'JWT_SECRET', 'MONGODB_URI']
});

// 2. Où c'est rangé, et comment c'est chiffré.
const store = createMongoCredentialStore({
  collection: mongoose.connection.collection('credentials'),
  isReady: () => mongoose.connection.readyState === 1
});
const cipher = createFieldCipher({ key: process.env.ENCRYPTION_KEY });

const vault = createCredentialVault({ store, catalog, cipher });

// 3. Le reste du code lit toujours process.env — il n'a rien à changer.
const hydrator = createEnvHydrator({ vault });
await hydrator.hydrate(catalog.keys());
hydrator.startRefresh(catalog.keys(), { intervalMs: 60_000 });
```

`vault.get('GROQ_API_KEY')` répond directement, et `process.env.GROQ_API_KEY`
dit la vérité pour tout le code qui ne sait pas lire de façon asynchrone.

## Le coffre

| Méthode | Ce qu'elle fait |
|---|---|
| `get(key)` | la base d'abord, le `.env` ensuite, `null` si débranchée |
| `getMany(keys)` | plusieurs clés en une seule lecture |
| `stored()` | ce que dit la BASE, sans repli — absente ≠ débranchée |
| `set(key, value, { updatedBy })` | chiffre et enregistre |
| `disconnect(key)` | débranche : le `.env` ne reprend PAS la main |
| `status()` | l'état de chaque clé, sûr à envoyer au navigateur |
| `forget()` | vide le cache (une minute par défaut) |

`status()` ne renvoie **jamais** une valeur secrète : seulement les quatre
derniers caractères. Une capture d'écran de la page des réglages ne doit rien
compromettre. Une valeur déclarée `secret: false` — un identifiant OAuth public,
une adresse d'expédition — est renvoyée en clair : elle existe pour être
vérifiée d'un coup d'œil.

Rien ne lève à la lecture. Pas de base, pas de cipher, une valeur abîmée : on
retombe sur le `.env`. **Un paiement ne doit pas échouer parce que la base a
hoqueté.** Une clé illisible n'emporte pas les autres.

## Le garde-valeur

Poste de développement et production partagent souvent le même store — c'est
tout l'intérêt de centraliser les clés. C'est sans danger tant que les valeurs
sont des valeurs de test ; c'est un désastre le jour où un portable récupère une
clé de paiement réelle et encaisse pour de vrai.

Le jugement porte donc sur la **valeur**, pas seulement sur l'environnement :

```js
const { createValueGuard } = require('@astratra/credentials');

const guard = createValueGuard({
  keys: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  // La clé dont le préfixe décide du sort de tout le groupe : une signature de
  // webhook ne dit rien d'elle-même, mais appartient au MÊME compte que la clé
  // secrète et doit suivre son sort.
  decidingKey: 'STRIPE_SECRET_KEY',
  livePattern: /^(sk|pk|rk)_live_/,
  testPattern: /^(sk|pk|rk)_test_/
});

createCredentialVault({ store, catalog, cipher, guard });
createEnvHydrator({ vault, guard });
```

Une valeur qu'on ne sait pas classer n'est jamais traitée comme réelle : un
garde-fou qui bloque à tort finit par être contourné.

Sans `guard`, rien n'est restreint — c'est ce que renvoie `createPermissiveGuard()`,
utilisable explicitement quand on veut le dire plutôt que l'omettre. Astratra n'a
pas d'avis sur les clés qui déplacent de l'argent chez toi.

## Le code de déverrouillage

Savoir le mot de passe du compte ne suffit pas. Remplacer une clé de paiement
par la sienne ne casse rien d'apparent — l'argent part simplement ailleurs.
C'est le genre de vol qu'on ne remarque qu'au relevé.

Ce module ne connaît pas l'e-mail : il fabrique, range et vérifie le code, et
`deliverCode` est à toi. **Envoie-le à l'adresse déjà enregistrée sur le compte,
jamais à une adresse fournie dans la requête** — ce serait offrir au voleur le
moyen de se l'envoyer à lui-même.

```js
const { createUnlockChallenge, createMongoChallengeStore, maskEmail } =
  require('@astratra/credentials');

const challenge = createUnlockChallenge({
  store: createMongoChallengeStore({ collection: db.collection('credentialChallenges') }),
  deliverCode: async ({ subjectId, code }) => {
    const account = await Users.findById(subjectId);
    await sendEmail(account.email, 'Code de modification', `Votre code : ${code}`);
    return { sentTo: maskEmail(account.email) };
  }
});
```

Six chiffres tirés par `crypto.randomInt`, comparés à durée constante, jamais
conservés en clair : une fuite de cette collection ne déverrouille rien. Cinq
tentatives, dix minutes de validité, puis dix minutes de fenêtre de saisie —
sinon poser les dix clés d'un fournisseur demanderait dix e-mails, et le
garde-fou finirait contourné plutôt qu'utilisé. Demander un nouveau code
**referme** la fenêtre en cours.

## L'écran qui les gère

Tout ce qui précède tourne sur le serveur. Ces fonctions-ci tournent dans
l'application — site ou mobile — et lisent ce que les routes renvoient.

```js
const spaces = readSpaces(payload);

coverageOf(spaces[0]);        // { done: 3, total: 5 } — la pastille de l'onglet
missingKeys(spaces);          // ce qu'il reste à régler, tous espaces confondus
firstSpaceToOpen(spaces);     // celui où il y a le plus à faire
unlockState(payload);         // { unlocked: true, minutesLeft: 4 }
cleanUnlockCode(' 12 34 56'); // '123456'
```

**La réponse du serveur est lue sans confiance en sa forme.** Un champ absent,
une source renommée, un `null` à la place d'un espace : chacun de ces cas
donnait un écran blanc avec une erreur de type derrière.

**Le doute profite au secret.** Une clé dont le drapeau `secret` manque est
**masquée**. Une clé mal étiquetée affichée en clair est une fuite ; masquée à
tort, c'est un désagrément mineur.

**Une clé volontairement débranchée compte comme manquante.** C'est un choix,
mais un choix qui laisse un service déconnecté : l'écran doit le montrer, pas
l'enterrer.

**La fenêtre de modification est jugée au moment de la LECTURE**, jamais à la
réception. Le serveur envoie une date, pas un compte à rebours : décider
« ouverte » à l'arrivée et s'y fier ensuite laisse un écran de réglages ouvert
une heure, persuadé qu'il a encore le droit d'écrire.

## Les routes

```js
const { createCredentialsRoutes } = require('@astratra/credentials');
const { authorizeRoles } = require('@astratra/security');

app.use('/api/credentials', createCredentialsRoutes({
  vault,
  challenge,
  authorize: authorizeRoles('owner')
}));
```

| Route | Effet |
|---|---|
| `GET /` | l'état des clés + la fenêtre ouverte, le cas échéant |
| `POST /challenge` | envoie le code à l'adresse du compte |
| `POST /unlock` | vérifie le code, ouvre la fenêtre |
| `PUT /:key` | enregistre une valeur |
| `DELETE /:key` | débranche une clé |
| `GET /:key/balance` | relit le solde chez le fournisseur (avec `balances`) |

`authorize` est **obligatoire** : ces clés engagent les paiements de toute la
plateforme, pas ceux d'un locataire, et Astratra n'a pas d'avis sur qui possède
l'argent. Sans `challenge`, les écritures passent directement — c'est ta
décision, pas un défaut.

## Les stores

Deux contrats, minuscules :

```
store de clés       : findAll() -> rows, upsert(row)
store de challenges : find(subjectId) -> record|null, save(subjectId, record)
```

Une ligne vaut `{ key, value, secret, updatedAt, updatedBy }`. `value` est déjà
chiffrée quand `secret` vaut `true` — le chiffrement a lieu dans le coffre, donc
un adapter ne voit jamais un secret en clair qu'il pourrait logger par accident.

Fournis : `createMemoryCredentialStore` et `createMemoryChallengeStore` (tests et
développement), `createMongoCredentialStore` et `createMongoChallengeStore`
(n'importe quelle collection du driver MongoDB, sans mongoose ni schéma).

`isReady` compte plus qu'il n'y paraît : mongoose met les requêtes en file
d'attente quand il n'est pas connecté. Sans ce garde, une lecture resterait
suspendue au lieu de retomber sur le `.env` — un paiement figé plutôt qu'un
paiement qui marche.

## L'hydratation de `process.env`

La plupart des codebases lisent leurs secrets en `process.env.MACHIN`, à
trente-six endroits. Convertir chacun en lecture asynchrone est un chantier
risqué pour un bénéfice nul : il suffit que `process.env` **dise la vérité**.

Trois cas, et le troisième est celui qu'on oublie :

- la base a une valeur → elle remplace celle du `.env` ;
- la base dit « débranchée » → la variable est **effacée**, le `.env` ne reprend pas ;
- la base ne dit rien → la valeur **d'origine** du `.env` est restaurée.

Sans le troisième, supprimer une clé laisserait l'ancienne valeur figée dans
`process.env` jusqu'au prochain redémarrage : un service qu'on croit débranché
et qui continue de fonctionner.

Les valeurs d'origine sont capturées **une seule fois**, au premier appel. Après
la première hydratation, `process.env` ne dit plus d'où il vient.

## Appliquer une saisie tout de suite

`onChange` est appelé après chaque écriture — branche-y l'hydratation pour que
la nouvelle valeur serve immédiatement plutôt qu'à la minute suivante :

```js
const vault = createCredentialVault({
  store, catalog, cipher, guard,
  onChange: () => hydrator.hydrate(catalog.keys())
});
```

## Changer de clé sans rien perdre

C'est la panne silencieuse par excellence. Remplace le cipher d'un coup et rien
ne lève : le coffre attrape l'échec de déchiffrement ligne par ligne, retombe
sur le `.env`, et toutes tes clés cessent simplement d'être utilisées. Les
paiements passent par l'ancienne valeur du fichier, ou ne passent plus du tout.
Tu l'apprends par un client, pas par un log.

Une rotation, c'est donc trois gestes — et celui du milieu est tout l'intérêt :

```js
const { createCredentialRotation } = require('@astratra/credentials');

// 1. Le coffre lit les DEUX générations. Rien n'a bougé, rien n'est cassé.
const vault = createCredentialVault({
  store, catalog, cipher: nouveauCipher, previousCipher: ancienCipher
});

// 2. Migrer, valeur par valeur.
const rotation = createCredentialRotation({
  store, catalog, to: nouveauCipher, from: ancienCipher
});

console.log(await rotation.plan());   // ce qui SERAIT fait — n'écrit rien
await rotation.apply();               // écrit

// 3. Vérifier AVANT de retirer l'ancien cipher.
const { complete, pending, unreadable, unreadableKeys } = await rotation.isComplete();
```

Ne saute jamais l'étape 3. Une valeur qu'aucun des deux ciphers ne lit est déjà
perdue, et retirer l'ancien est ce qui rend cette perte définitive —
`unreadableKeys` te dit lesquelles regarder.

Les écritures utilisent **toujours** le cipher courant, jamais l'ancien : c'est
ce qui fait converger la rotation au lieu de la faire osciller.

Tout est rejouable. Une valeur déjà migrée est reconnue et laissée intacte, donc
un passage interrompu se relance simplement.

| Ce que la rotation renvoie | Sens |
|---|---|
| `rotated` | relue avec l'ancien cipher, réécrite avec le nouveau |
| `already` | déjà lisible avec le nouveau — rien à faire |
| `plain` | déclarée `secret: false`, son clair est voulu |
| `skipped` | marqueur de débranchement ou valeur vide |
| `unreadable` | **aucun des deux ciphers ne la lit** — à examiner |

## Le solde chez le fournisseur

Certains fournisseurs vendent un quota qui s'épuise — et certaines offres
gratuites ne se renouvellent jamais. Sans le chiffre à l'écran, on découvre la
panne le jour où le service cesse de répondre, et ce qui en dépendait se
dégrade sans rien dire.

```js
const { createBalanceProbe, serperBalanceProbe } = require('@astratra/credentials');

const balances = createBalanceProbe({
  vault,
  catalog,
  probes: {
    // Premier exemple fourni : le stock de crédits Serper.
    SERPER_API_KEY: serperBalanceProbe({ fetch }),
    // N'importe quel autre fournisseur : un read() au-dessus d'un fetch injecté.
    AUTRE_API_KEY: {
      read: async (cle, { signal }) => lireQuota(cle, signal), // -> { balance, rateLimit? }
      thresholds: { low: 1000, critical: 100 },
      unit: 'requêtes',
      renewable: true
    }
  }
});

app.use('/api/credentials', createCredentialsRoutes({ vault, challenge, authorize, balances }));
```

`GET /` ajoute alors `balance` à chaque clé **en place** qui a une sonde :

```js
{ status: 'low', critical: true, balance: 199, rateLimit: 5, unit: 'credits',
  renewable: false, code: null, checkedAt: '2026-09-28T10:00:00.000Z' }
```

| `status` | Sens |
|---|---|
| `ok` | au-dessus des seuils |
| `low` | sous `low` ; `critical: true` sous `critical` |
| `empty` | zéro ou moins, quels que soient les seuils |
| `unknown` | aucune clé à sonder (absente ou débranchée) |
| `error` | le relevé a échoué — `code` dit pourquoi, `balance` vaut `null` |

Les codes d'échec : `unreachable`, `timeout`, `rejected` (avec `httpStatus`,
pour distinguer une clé révoquée d'une panne), `unreadable`, `no_balance`,
`failed`. Des codes, jamais du texte : l'écran traduit.

Ce que les tests fixent :

**Un relevé raté se dit, jamais de chiffre inventé.** Une réponse sans solde
exploitable est une erreur, pas un zéro.

**La clé sondée est celle que sert le coffre** : celle saisie dans
l'interface l'emporte sur le `.env`, une clé débranchée n'est pas sondée.

**La clé ne ressort jamais** : ni dans le résultat, ni dans un journal, ni dans
une erreur — ni sa valeur, ni une empreinte, ni sa longueur. Une empreinte est
gardée en mémoire seulement, pour remarquer qu'elle a changé : le relevé mis
en cache décrivait alors un autre compte.

**Un relevé est mis en cache** (`cacheMs`, 5 minutes), un échec moins
longtemps (`errorCacheMs`, 30 secondes) ; deux écrans qui demandent en même
temps partagent une seule requête ; un rafraîchissement forcé ne repart pas
chez le fournisseur à moins de `minRefreshMs` du précédent. Enregistrer ou
débrancher la clé oublie le relevé.

Côté écran, `readBalance(raw)` lit le solde sans croire sa forme — un statut
qui prétend un chiffre sans en porter un est lu comme illisible — et
`balanceAlerts(spaces)` liste ce qui demande attention, du plus urgent au
moins urgent : épuisé, critique, bas, illisible.

`readSpaces` lit aussi désormais les sources telles que le coffre les envoie
(`environment`, `disconnected`, `absent`) : auparavant une clé servie par le
`.env` s'affichait « absente ».

## Ce que ce package ne fait pas

- Il ne fournit **aucun catalogue** de fournisseurs. Quelles clés existent et ce
  qui cesse de marcher sans chacune, c'est ton produit qui le sait.
- Il accepte ton cipher existant ; `createContextCipher` fournit aussi AES-256-GCM
  avec contexte authentifié (depuis 1.1.0).
- Il ne décide pas **qui** a le droit d'y toucher.
- Il n'envoie **aucun e-mail**.

## Tests

```bash
npm test --workspace @astratra/credentials
```

## Ajouts de la version 1.1.0

Les options existantes gardent leurs valeurs par défaut : espace plat, repli
sur l'environnement, cache de 60 secondes, aucune version conservée. Les
ciphers à un argument continuent de fonctionner.

### Lecture stricte et espaces isolés

```js
const {
  createCredentialVault, createContextCipher,
  createMemoryVersionedCredentialStore
} = require('@astratra/credentials');

const scope = { tenant: 'organisation-123', environment: 'production' };
const cipher = createContextCipher({ key: cleDe32Octets }); // Buffer, conservé par le serveur
const store = createMemoryVersionedCredentialStore(); // tests/développement
const vault = createCredentialVault({
  catalog, store, cipher, scope,
  strict: true,
  fallback: 'none',
  history: true,
  retentionMs: 30 * 86400_000,
  cacheMs: 0,
  onWrite: async (event) => invaliderOuProgrammerLivraison(event)
});
```

`strict: true` lève une erreur constante en cas de lecture du store ou de
chiffrement illisible, y compris via `getMany`, `stored` et `status`. Son
`code` est `CREDENTIAL_STORE_UNREADABLE` ou `CREDENTIAL_VALUE_UNREADABLE`.
L'événement de journal est constant : aucune valeur ni message brut de
l'adapter. Une clé absente reste une absence : `strict` ne supprime pas à lui
seul le repli ; `fallback: 'none'` le désactive, même pour une clé absente.
Un cache encore valide peut servir sa valeur sans lire la base ; avec
`cacheMs: 0`, chaque lecture contrôle le store. Une erreur de lecture après
expiration ne sert jamais le cache périmé en mode strict.

`scope: { tenant, environment }` lie toutes les opérations d'un coffre au même
locataire et au même environnement. Les deux champs sont obligatoires et non
vides ; leurs valeurs restent celles fournies par l'app (`production`,
`preproduction`, `development`, ou ses propres noms). Crée un coffre par
couple, sans partager `process.env` pour hydrater les secrets des locataires.
L'app choisit le locataire depuis son autorisation serveur.

Les stores mémoire et Mongo fournis isolent aussi l'espace plat (champs
`tenant`/`environment` absents ou nuls). Pour un store personnalisé, annonce
`supportsScopes: true` et implémente `findAll(scope?, { strict }?)` et
`upsert(row)` avec les champs `tenant` et `environment`. Un store sans support
explicite est refusé pour un coffre scoped. `isReady: false` du store Mongo
lève en mode strict et garde le retour vide historique autrement.
Sur une collection Mongo classique existante, remplace un éventuel index
unique `{ key: 1 }` par `{ tenant: 1, environment: 1, key: 1 }` avant d'utiliser
plusieurs espaces ; cette migration reste à la charge de l'app.

### Chiffrement authentifié

```js
const contexte = {
  tenant: 'organisation-123', environment: 'production', name: 'SERVICE_KEY', version: 1
};
const chiffre = cipher.encrypt('valeur', contexte);
const clair = cipher.decrypt(chiffre, contexte);
```

Le contexte est fourni séparément, jamais récupéré d'un contexte embarqué
auquel on ferait confiance. AES-256-GCM authentifie chaque champ en AAD dans
un ordre canonique. Un autre locataire, environnement, nom ou numéro de version
refuse le déchiffrement. Les nonces sont aléatoires ; le format JSON transporte
seulement `v`, `iv`, `tag`, `data`. La clé doit être un Buffer de 32 octets.
Le coffre transmet automatiquement le contexte : `tenant`/`environment` sont
`null` dans l'espace plat, `version` vaut `0` sans historique. Le contexte est
obligatoire pour ce cipher, même si les anciens ciphers l'ignorent.

Changer le format d'anciens chiffrés exige une migration explicite.
`previousCipher` reste disponible pour lire une ancienne génération ; une
fois retiré, les anciens chiffrés ne doivent plus dépendre de lui. La rotation
classique accepte `scope` et transmet l'AAD, mais refuse les stores versionnés :
avec l'historique, écris une nouvelle version via un coffre utilisant le cipher
courant et garde l'ancien cipher tant que des versions conservées en ont besoin.

### Versions et conservation

```js
await vault.set('SERVICE_KEY', 'nouvelle-valeur', { updatedBy: 'acteur-123' });
await vault.get('SERVICE_KEY');                 // courante
await vault.get('SERVICE_KEY', { version: 1 }); // ancienne, ou null si absente/expirée/purgée
await vault.listVersions('SERVICE_KEY');       // métadonnées seulement, récente d'abord
await vault.purgeVersions();                   // nombre de chiffrés effacés dans CET espace
```

`history: true` exige un store versionné. Chaque `set` et `disconnect` crée
une version ; les écritures concurrentes ne réutilisent pas les numéros.
La conservation démarre au retrait de la version courante : une version
courante n'expire jamais. `retentionMs: 0` retire immédiatement l'accès aux
anciennes valeurs. La purge efface leur chiffré, conserve leurs métadonnées
et marque `purged: true`. Programme `purgeVersions()` périodiquement pour
l'effacement physique ; une lecture refuse déjà une ancienne valeur expirée.
Une version absente ne reprend jamais la valeur de l'environnement.

Les métadonnées sont `{ key, tenant?, environment?, version?, updatedAt,
updatedBy, retiredAt, expiresAt, purged }` ; jamais `value`.
Les gardes de lecture restent appliqués aux valeurs historiques.

Stores fournis : `createMemoryVersionedCredentialStore()` et
`createMongoVersionedCredentialStore({ collection, isReady?, maxTimeMS? })`.
Le second exige une collection dédiée et stocke un document par clé isolée ;
son `_id` unique et sa révision compare-and-swap rendent l'ajout atomique sans
transaction multi-document. L'historique de métadonnées grossit : archive-le
avant la limite de taille des documents Mongo si une clé reçoit beaucoup
d'écritures. Il ne réutilise pas automatiquement la collection du store plat.
Pour PostgreSQL ou le schéma existant de la Centrale, fournis cet adapter :

```text
supportsScopes: true
findAll(scope?, { strict }?) -> lignes courantes chiffrées
upsert(row) -> refusé (utiliser appendVersion)
appendVersion(key, scope, build(version), retentionMs) -> ligne écrite
findVersion(key, version, scope?) -> ligne ou null
listVersions(key, scope?) -> métadonnées
purgeVersions(date, scope?) -> nombre effacé
```

`appendVersion` doit attribuer une version et appeler `build(version)` dans
une opération atomique par clé ; `build` chiffre avec ce numéro en AAD.
Le store retire la version précédente avec `retiredAt`/`expiresAt` et ne
retourne la nouvelle ligne qu'après validation de l'écriture.

### Crochet et rechargement à chaud

`onWrite(event)` reçoit les métadonnées ci-dessus et `action: 'set' |
'disconnect'`, après validation de l'écriture et invalidation du cache local.
`onChange({ key, action })` reste disponible et est appelé ensuite.
Si `onWrite` échoue, l'erreur constante porte
`code: 'CREDENTIAL_AFTER_WRITE_FAILED', committed: true` : la clé a été écrite,
la livraison ou l'invalidation doit être reprise sans réécrire une version.
Le crochet n'est pas une file durable ni une transaction avec ta livraison.

Dans un processus, les écritures oublient automatiquement le cache ; une
lecture déjà en cours ne peut pas remettre une ancienne image après cela.
Entre processus, utilise le crochet pour publier une invalidation vers
`vault.forget()` dans chaque lecteur, ou `cacheMs: 0` pour relire à chaque
appel. Un `cacheMs` positif borne le délai d'une modification externe.

### Défi injectable pour UNE lecture

Le déverrouillage par courrier existant (`createUnlockChallenge`) reste
inchangé. La nouvelle primitive ne crée pas de fenêtre générale :

```js
const { createReadChallenge, createMemoryReadChallengeStore } = require('@astratra/credentials');
const lecture = createReadChallenge({
  store: createMemoryReadChallengeStore(),
  ttlMs: 60_000, // maximum 5 minutes
  verify: async ({ challenge, proof }) => verifierPasskeyDeLApp(challenge, proof)
});
const defi = await lecture.request('acteur-123', {
  key: 'SERVICE_KEY', scope, version: 1 // version facultative : courante à la lecture
});
const valeur = await lecture.read('acteur-123', defi.id, assertion, vault);
```

Le vérificateur doit renvoyer exactement `true` et vérifier le nonce,
l'identité et le contexte signé (ainsi que l'origine/RP pour une passkey).
Le défi est lié au sujet, à la clé, à la version demandée et à l'espace ; il
est consommé atomiquement **avant** la vérification, même en cas de refus.
Il ne peut être rejoué, y compris simultanément ; son expiration est contrôlée
avant et après la vérification. La lecture ne sert qu'au code serveur autorisé.
`vault.get()` reste l'API serveur pour les services ; elle n'exige pas ce défi.

`createMongoReadChallengeStore({ collection })` fournit le store durable
avec `findOneAndDelete` (driver Mongo supportant `includeResultMetadata: false`).
Les adapters personnalisés implémentent `save(record)` et
`consume(id, subjectId)` atomiquement. Un index TTL sur `expiresAt` peut nettoyer
les défis expirés non consommés ; la primitive vérifie toujours la date.

### Sonde d'essai générique

```js
const { createKeyProbe } = require('@astratra/credentials');
const essais = createKeyProbe({
  vault, transport: monTransportInjecte, timeoutMs: 10_000,
  probes: {
    SERVICE_KEY: async (valeur, { transport, signal }) => {
      const reponse = await transport(urlFixeDuService, {
        headers: { Authorization: `Bearer ${valeur}` }, signal
      });
      return reponse.ok ? 'ok' : reponse.status === 429 ? 'quota'
        : [401, 403].includes(reponse.status) ? 'rejected' : 'unavailable';
    }
  }
});
await essais.check('SERVICE_KEY'); // { status: 'ok' | 'rejected' | 'quota' | 'unavailable' }
```

La sonde utilise la valeur servie par le coffre, un transport obligatoirement
injecté et un signal d'annulation. Clé absente/débranchée, service inconnu,
échec du coffre, erreur de transport, délai dépassé ou réponse mal formée :
`unavailable`. Seul le statut sort ; aucune réponse brute, valeur ou erreur
fournisseur n'est journalisée. Les callbacks injectés reçoivent le secret pour
l'utiliser et doivent eux aussi éviter de le journaliser. La sonde de solde
Serper et `createBalanceProbe` gardent leur API actuelle.
