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

## Ce que ce package ne fait pas

- Il ne fournit **aucun catalogue** de fournisseurs. Quelles clés existent et ce
  qui cesse de marcher sans chacune, c'est ton produit qui le sait.
- Il ne **chiffre** rien lui-même : passe-lui un cipher, par exemple
  `createFieldCipher` de `@astratra/security`.
- Il ne décide pas **qui** a le droit d'y toucher.
- Il n'envoie **aucun e-mail**.

## Tests

```bash
npm test --workspace @astratra/credentials
```
