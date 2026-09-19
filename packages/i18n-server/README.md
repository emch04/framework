# @astratra/i18n-server

Les textes de l'interface sont traduits côté client. Les messages d'erreur, non :
ils viennent de l'API et s'affichent tels quels. Une application en anglais
répond donc « Cet élève est introuvable. » à un parent anglophone.

C'est le genre de trou que personne ne remarque, jusqu'à ce que quelqu'un qui ne
lit pas ta langue tombe sur une erreur.

Ce package traduit ce que le serveur renvoie, et fournit l'audit qui empêche ces
phrases de redevenir illisibles.

## L'astuce qui rend l'adoption gratuite

**La clé, c'est la phrase source elle-même.** Aucun identifiant à inventer,
aucun appel à modifier, et une phrase absente du catalogue revient dans la
langue d'origine — c'est-à-dire exactement le comportement actuel.

Tu peux donc brancher ça sur un produit en production et remplir le catalogue
ensuite, sans aucune régression entre les deux.

## Mise en place

```js
const {
  createMessageCatalog,
  createLanguageResolver,
  createTranslationMiddleware
} = require('@astratra/i18n-server');

const catalog = createMessageCatalog({
  languages: ['fr', 'en', 'es'],
  defaultLanguage: 'fr',
  messages: {
    'Cet élève est introuvable.': {
      en: 'This student could not be found.',
      es: 'No se encuentra a este alumno.',
    },
    'Connectez-vous pour continuer.': {
      en: 'Sign in to continue.',
      // l'espagnol viendra plus tard — en attendant, le français s'affiche
    },
  },
});

const resolver = createLanguageResolver({
  languages: ['fr', 'en', 'es'],
  // Une préférence enregistrée l'emporte sur celle du navigateur.
  read: (req) => req.user?.language,
});

app.use(createTranslationMiddleware({ catalog, resolver }));
```

Et c'est tout. Tes contrôleurs continuent d'écrire leurs phrases comme avant ;
la traduction se fait une fois, à la sortie, en enveloppant `res.json`.

## Ce que le middleware ne touche pas

**Jamais les données.** Seuls les champs que tu nommes — `message` par défaut —
sont traduits. Traduire une valeur de `data` la corromprait : un nom d'élève
n'a pas à passer par un catalogue.

```js
createTranslationMiddleware({ catalog, resolver, fields: ['message', 'title'] });
```

La langue résolue est posée sur la requête (`req.language`) pour les cas où un
contrôleur en a besoin.

## La langue demandée

`Accept-Language` est déjà envoyé par tous les navigateurs, donc aucun client
n'a à changer. Une langue que tu ne sers pas retombe sur la langue source :
mieux vaut une phrase compréhensible dans une autre langue qu'une clé technique.

La première langue **reconnue** l'emporte, même précédée d'une inconnue —
`de,es;q=0.8` donne `es`, pas la valeur par défaut.

## Savoir où en est le catalogue

```js
catalog.coverage();
// { fr: { translated: 2, total: 2, missing: [] },
//   en: { translated: 2, total: 2, missing: [] },
//   es: { translated: 1, total: 2, missing: ['Connectez-vous pour continuer.'] } }
```

Un catalogue que personne ne mesure est un catalogue qu'on arrête de remplir.
`missing` te donne la liste de travail.

## L'audit — la partie qui vaut le plus

Les messages d'erreur sont lus par des clients, des parents, des commerçants.
Laissés seuls, ils dérivent vers le terminal : « payload invalide », « token
expiré », « introuvable ». Chacun est exact, et chacun laisse le lecteur sans
rien à faire.

Ce n'est pas un contrôle de style. Il cherche deux échecs précis : des mots qui
n'existent que pour un développeur, et des phrases si courtes qu'elles
n'apprennent rien.

```js
const { createMessageAudit, collectMessages } = require('@astratra/i18n-server');

test('ce qu\'un client peut lire', () => {
  const messages = collectMessages({
    root: path.join(__dirname, '..', 'src'),
    // Le motif est à toi, parce que la forme de tes appels est à toi.
    // Il doit exposer le message en premier groupe de capture.
    pattern: /apiResponse\(\s*res\s*,\s*[45]\d{2}\s*,\s*"([^"]+)"/g,
  });

  const audit = createMessageAudit();
  const findings = audit.inspect(messages);

  expect(audit.describe(findings)).toEqual([]);
});
```

Mets-le dans ta suite de tests, et la règle se défend toute seule à partir de
là. C'est cette discipline qui a de la valeur, plus que le code.

Le vocabulaire banni est configurable, et `allow` existe pour le cas rare où le
mot technique EST le plus clair :

```js
createMessageAudit({
  jargon: [...DEFAULT_JARGON, /\bwidget\b/i],
  minWords: 4,
  allow: ["Votre jeton d'accès a expiré. Reconnectez-vous."],
});
```


## La langue du courrier n'est pas celle de l'interface

`createLanguageResolver` répond à « quelle langue l'appelant demande-t-il ? ».
Un e-mail pose une autre question : « quelle langue lit la personne à qui
j'écris ? ». La plupart des courriels partent d'une tâche planifiée, d'une file,
ou d'un geste fait par **quelqu'un d'autre** — un administrateur qui
réinitialise un mot de passe, un enseignant qui écrit à une famille. L'en-tête
de la requête, s'il existe, est celui de l'expéditeur.

Et l'on peut travailler dans l'application en anglais et vouloir son courrier
en français. D'où un champ à part (`emailLang` par défaut), lu **en premier**,
avec la valeur `auto` qui veut dire « comme l'interface ».

```js
const { createRecipientLanguage } = require('@astratra/i18n-server');

const mailLanguage = createRecipientLanguage({
  languages: ['fr', 'en', 'es'],
  // mailField: 'emailLang', interfaceFields: ['lang'], followValue: 'auto'
});

mailLanguage.languageOf({ lang: 'fr', emailLang: 'en' });   // 'en'
mailLanguage.languageOf({ lang: 'fr', emailLang: 'auto' }); // 'fr'
mailLanguage.languageOf(null, req);                         // Accept-Language, puis le défaut

// Pour l'écran de réglages : refuser plutôt qu'enregistrer une langue inconnue.
mailLanguage.choices;        // ['auto', 'fr', 'en', 'es']
mailLanguage.isChoice('de'); // false
```

Ordre : le choix du courrier (sauf `auto`), puis les champs de l'interface,
puis l'en-tête, puis la langue par défaut. Une valeur enregistrée qu'on ne sert
pas **passe au suivant** au lieu d'imposer le défaut.

## Relire le destinataire avant de lui écrire

C'est la règle qui a coûté le plus cher. Le jeton de session porte un
identifiant et un rôle, **jamais la langue**. Un compte lu avec une projection
écrite pour autre chose (`email fullName`) l'a perdue aussi. Dans les deux cas
le résolveur ne voit rien, retombe sur le défaut, et le courrier part dans la
mauvaise langue — sans bruit, puisqu'un e-mail dans la mauvaise langue
« fonctionne ».

```js
const { createRecipientReloader } = require('@astratra/i18n-server');

const recipients = createRecipientReloader({
  // Ton accès aux données. `fields` est la liste EXACTE à sélectionner.
  load: (id, fields, role) => modelFor(role).findById(id).select(fields.join(' ')).lean(),
  fields: ['email', 'fullName'],
  language: mailLanguage, // ses champs (emailLang, lang) sont TOUJOURS ajoutés
});

const recipient = await recipients.reload(req.user, req.user.role);
const lang = mailLanguage.languageOf(recipient);
```

- Ce que dit la base l'emporte sur ce que portait le jeton : une adresse dans
  un jeton peut être périmée, jamais plus fraîche.
- **Ne lève jamais.** Un compte illisible reçoit quand même son courrier, dans
  la langue de repli : mieux vaut un e-mail dans la mauvaise langue que pas
  d'e-mail, et ce dont il parle (un code, une réinitialisation) a déjà eu lieu.

## Une clé répétée dans un catalogue

Une clé écrite deux fois dans un littéral JavaScript garde la **dernière**
valeur, sans rien dire. Une phrase avait deux traductions dans une même langue,
la première relue et juste, la seconde ancienne et fausse : seule la fausse
était servie. `Object.keys()` ne peut pas le voir — une fois l'objet construit,
la première valeur n'existe plus. Seule la source montre les deux.

```js
const { findDuplicateKeys } = require('@astratra/i18n-server');

test('aucune phrase cataloguée deux fois', () => {
  const source = fs.readFileSync(require.resolve('../src/messages'), 'utf8');
  const { keys, duplicates } = findDuplicateKeys(source, { start: 'const CATALOG = {' });

  expect(duplicates).toEqual([]);
  // La preuve que l'audit a lu tout l'objet :
  expect(keys).toHaveLength(Object.keys(CATALOG).length);
});
```

Seules les clés directes de l'objet sont comptées : le `en:` de chaque entrée
n'est pas un doublon. Les chaînes, gabarits et commentaires sont masqués avant
la lecture. Ce n'est pas un analyseur complet : une accolade dans une
expression régulière **à l'intérieur** de l'objet fausserait la profondeur.

## Pas d'objet d'e-mail écrit en dur

Un corps traduit autour d'un objet tapé dans le code se lit comme un bug — et
l'objet est la seule ligne que tout le monde voit.

```js
const { findHardcodedSubjects, scanSourceTree } = require('@astratra/i18n-server');

test('les objets viennent du catalogue', () => {
  const findings = scanSourceTree({
    root: path.join(__dirname, '..', 'src', 'modules'),
    ignore: ['node_modules', 'monitoring/alerts.js'], // alertes internes : exemptées
    inspect: (source) => findHardcodedSubjects(source, {
      callee: 'sendEmail',
      argument: 1,                  // sendEmail(to, subject, …)
      ignore: [/TEAM_EMAIL/],       // un destinataire interne fixe
    }),
  });
  expect(findings).toEqual([]);
});

// Forme objet : mailer.send({ to, subject: '…' })
findHardcodedSubjects(source, { callee: 'mailer.send', property: 'subject' });
```

Par défaut, tout littéral contenant une lettre est signalé. `test` le
restreint à une langue si ton code garde légitimement des objets internes dans
une autre. Un appel dans un commentaire ou une chaîne n'est pas un appel.

## Aucun mot d'une autre langue dans un e-mail rendu

Le défaut visé n'est pas la traduction manquante — elle se voit. C'est l'e-mail
traduit avec **une** ligne restée dans la langue source : un pied de page
fabriqué par une aide que personne n'a pensé à traduire, une date formatée avec
la locale du serveur.

```js
const { createLanguageLeakCheck } = require('@astratra/i18n-server');

const leak = createLanguageLeakCheck({
  // Des mots qui n'existent QUE dans chaque langue. Pronoms et salutations
  // sont fiables ; « message », « code » ou « date » sont partagés.
  markers: {
    fr: ['vous', 'votre', 'bonjour'],
    en: ['your', 'hello'],
  },
});

test('interface en français, courrier en anglais', async () => {
  const mail = await renderResetMail({ lang: 'fr', emailLang: 'en' });
  const result = leak.inspect(mail, 'en'); // { subject, text, html }
  expect(leak.describe(result)).toEqual([]);
});
```

Rends toujours l'e-mail pour un compte dont l'interface et le courrier
diffèrent : c'est le seul cas qui distingue les deux champs. Le HTML est lu
comme la personne le lit (styles, scripts et balises retirés), et un
`<html lang>` d'une autre langue est signalé aussi (`requireHtmlLang: true`
pour exiger qu'il existe).

## Ce que ce package ne fait pas

- Il n'a **aucune langue** par défaut. `fr`/`en`/`es` est le choix d'un produit.
- Il ne traduit **pas** ton interface : ça, c'est le travail du client.
- Il n'appelle aucun service de traduction. Les phrases sont écrites par des
  humains, une fois.
- Il ne fournit pas de dictionnaire à clés nommées pour tes e-mails : le
  catalogue garde la phrase source pour clé, et chaque produit a déjà le sien.
- Aucune dépendance à l'exécution.

## Tests

```bash
npm test --workspace @astratra/i18n-server
```
