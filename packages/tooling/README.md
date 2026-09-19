# @astratra/tooling

CLI pour l'audit et les tâches génériques de maintenance de projet. Fournit
un binaire `astratra`. Dépend de `@astratra/core`.

Rien dans ce package ne connaît la structure de dossiers, les noms de rôles
ou la cible de déploiement d'un projet précis — chaque chemin et pattern a
une valeur par défaut neutre, surchargeable via `astratra.config.json` (ou
`.js`) à la racine du projet consommateur.

## Commandes

```bash
astratra audit:secrets [--dir=<path>]        # détecte les secrets littéraux loggés ou renvoyés dans des réponses API
astratra audit:routes  [--dir=<path>]        # détecte les routes Express *.routes.js sans middleware d'auth apparent
astratra audit:i18n    [--dir=<path>]        # détecte les incohérences de clés de traduction entre langues
astratra audit:deps    [--severity=<level>]  # relaie "npm audit" et échoue si une dépendance a une CVE >= seuil
astratra test                                # lance le script 'test' de chaque workspace et agrège le résultat
astratra deploy [--mode=<name>]              # exécute les étapes de déploiement définies dans votre propre config — aucune logique de déploiement intégrée
```

Chaque commande retourne un exit code non-zéro en cas de findings/échecs —
utilisable directement en CI.

`audit:deps` ne réimplémente rien : il lance `npm audit --json` dans le
projet consommateur et filtre le rapport par sévérité (`info` < `low` <
`moderate` < `high` < `critical`, seuil par défaut `moderate`, l'échelle de
npm elle-même). Ce que ça ajoute par rapport à un simple `npm audit` : un
exit code homogène avec les autres commandes `audit:*` pour la CI, et un
seuil configurable au lieu du tout-ou-rien de npm.

## Configuration (`astratra.config.json`)

```json
{
  "audit": {
    "secrets": { "dirs": ["src"] },
    "routes": {
      "dirs": ["src"],
      "authMiddlewarePatterns": ["authMiddleware", "authorizeRoles"],
      "publicMarkers": ["public", "webhook", "health"]
    },
    "i18n": { "localesDir": "locales", "sourceDirs": ["src"] },
    "deps": { "severityThreshold": "moderate" }
  },
  "test": { "workspaces": null },
  "deploy": {
    "steps": ["npm run build", "npm test"],
    "modes": { "fast": { "skip": ["step-2"] } }
  }
}
```

`deploy` est un orchestrateur, pas un mécanisme de déploiement : il exécute
simplement les commandes shell que vous listez, dans l'ordre, et s'arrête au
premier échec. Il ne connaît ni pm2, ni Docker, ni aucun VPS précis — cette
logique reste dans votre propre projet.

## Gardes de test

Trois fonctions à appeler depuis les tests de ton application. Elles lisent
tes sources et tes textes ; aucun rôle, aucun mot, aucun chemin n'est imposé.

### Ce rôle voit, il n'écrit pas

```js
const { assertRoleReadOnly } = require('@astratra/tooling');

test('le support lit, il n’écrit pas', () => {
  assertRoleReadOnly({
    rootDir: path.join(__dirname, '..'),
    dirs: ['src/modules'],
    role: ['ROLES.SUPPORT', "'support'"],          // chaque graphie du rôle
    exceptions: [
      { match: '"/:id/activate"', reason: 'activer un compte relève de la plateforme' },
    ],
  });
});
```

Relève chaque `router.post|put|patch|delete(...)` (et `app.*`, `xxxRouter.*`,
`.route('/x').put(...)`) dont les arguments contiennent le rôle, directement ou
via une liste déclarée **dans le même fichier** (`authorizeRoles(...WRITERS)`).
Relève aussi les listes nommées comme des listes d'auteurs (`writers`,
`EDITORS`, `APPROVERS`...) qui le contiennent — l'autorisation vit parfois dans
le contrôleur.

- `x !== ROLE`, `liste.filter((r) => r !== ROLE)` et `except(liste, ROLE)`
  retirent le rôle : la route qui le **refuse** n'est pas signalée.
- Une exception **sans raison écrite est refusée**, et une exception qui ne
  correspond plus à rien fait échouer le test : elle attendait d'excuser en
  silence la prochaine route qui prendrait ce nom.
- Un commentaire ou une chaîne qui nomme le rôle ne compte pas.

`auditRoleWrites` rend `{ findings, exempted, unusedExceptions }` sans lever,
`auditRoleWriteSource(source, options)` travaille sur une chaîne. Options :
`writeCalls` (groupe 1 = verbe), `authorListNames` (RegExp ou `false`),
`exclusions`, `include`, `skippedDirs`.

C'est une heuristique sur le texte : une liste importée d'un autre fichier
n'est pas suivie, un garde posé par `router.use(...)` n'est pas vu.

### Ce que dit le texte = ce que fait le code

```js
const { assertFactsAligned, extractMatches, pickPaths } = require('@astratra/tooling');

const facts = {
  ...extractMatches(read('config/plans.js'), { pro: /key: "pro"[^}]*?price: "\$(\d+)"/ }),
  rate: require('../config/billing').COMMISSION_RATE,
};
const claims = pickPaths(require('../knowledge/rules.json'), { pro: 'plans.pro.price', rate: 'commission.rate' });

assertFactsAligned({ facts, claims });
```

- `mismatches` : le texte contredit le code (listes comparées sans ordre par
  défaut, nombres à 1e-9 près).
- `unextracted` : une valeur est `undefined`/`NaN`. **Deux extractions ratées ne
  sont jamais un accord** — une regex qui ne matche plus rend `undefined` des
  deux côtés, et une comparaison naïve appelle ça égal.
- `unbacked` : une affirmation qu'aucun fait ne vérifie.
- `unstated` : un fait que le texte tait (échec seulement avec `requireEveryFact`).

### Mots interdits dans les textes produits

```js
const { assertNoForbiddenTerms, findForbiddenTermsInFiles } = require('@astratra/tooling');

assertNoForbiddenTerms({ invite: buildPrompt('admin') }, [
  { pattern: /north(ern)?/i, reason: 'le produit est vendu partout' },
  'ACME',
], { required: ['worldwide'], allow: ['Acme Pay'] });
```

Un terme chaîne est un **mot entier**, sans casse, compatible Unicode : en
sous-chaîne, un sigle de trois lettres se trouve dans des mots ordinaires. Pour
une racine, passe une RegExp. **Une mention niée reste une mention** : « pas
seulement pour X » nomme X, et un modèle de langage lit les mots, pas
l'intention de la phrase. Seul `allow` (appliqué à la ligne) fait une exception.
`findForbiddenTermsInFiles({ dirs, terms })` fait la même chose sur disque, en
sautant les tests.

## Tests

```bash
npm test --workspace @astratra/tooling
```
