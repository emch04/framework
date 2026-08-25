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

## Ce que ce package ne fait pas

- Il n'a **aucune langue** par défaut. `fr`/`en`/`es` est le choix d'un produit.
- Il ne traduit **pas** ton interface : ça, c'est le travail du client.
- Il n'appelle aucun service de traduction. Les phrases sont écrites par des
  humains, une fois.
- Aucune dépendance à l'exécution.

## Tests

```bash
npm test --workspace @astratra/i18n-server
```
