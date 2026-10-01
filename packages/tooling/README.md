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
astratra deploy [--mode=<name>]              # exécute les étapes de déploiement définies dans votre propre config
astratra deploy --remote  (ou deploy:remote)  # déploiement git complet vers un serveur (voir « Déploiement distant »)
astratra deploy:health                       # santé du serveur : URLs publiques et internes, pm2, âge de la dernière sauvegarde
astratra publish <ios|android|all|update>    # build EAS (chez Expo ou sur la machine), montée de version auto, envoi Google Play / App Store Connect
astratra publish:fingerprint [--record]      # compare l'empreinte native à la dernière publiée
astratra publish:upload --platform=<p> --file=<archive>   # envoie un .aab/.ipa déjà construit
astratra publish:check-ios                   # vérifie la clé App Store Connect (un appel signé, rien de construit)
astratra dispatch:generate [--out=<file>] [--key=<file.pub>]   # script de commande forcée SSH + ligne authorized_keys
astratra eval --provider=<id> [--cases=<file>] [--base-url=<url>] [--api-key-env=<VAR>] [--min-pass=<0..1>]   # évalue un modèle sur un jeu de cas (promptfoo)
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

`deploy` sans option exécute les commandes shell que vous listez, dans
l'ordre, et s'arrête au premier échec. Une étape peut porter son propre `cwd`,
un `env` et un `logFile` (sortie longue envoyée dans un fichier).

## Déploiement distant (`deploy --remote`)

`--dry-run` affiche la configuration effective sans prendre de verrou, lancer
les tests, pousser, ouvrir SSH ni sonder la production. Le marqueur distant
vaut `@@astratra` par défaut ; `deploy.remote.marker` permet par exemple
`@@tertius`, et `showMarkers: true` les affiche aussi dans le terminal. Le
commit poussé est vérifié avec `git ls-remote`, et un code SSH
non nul reste un échec même si le serveur a imprimé `result=deployed`.

Aucun hôte, utilisateur, port ni nom pm2 n'est écrit dans le package : tout
vient de `deploy.remote`.

```json
{
  "deploy": {
    "remote": {
      "host": "mon-vps",
      "appUser": "app", "appDir": "/home/app/app", "nodeDir": "/home/app/node",
      "branch": "main",
      "preSteps": [{ "name": "tests serveur", "command": "npm test", "cwd": "apps/server", "logFile": ".deploy/tests.log" }],
      "depsPattern": "^(package-lock\\.json|apps/server/package\\.json)$",
      "installCommand": "npm ci --omit=dev --workspace server --include-workspace-root=false",
      "pm2": { "ecosystem": "deploy/ecosystem.config.cjs" },
      "health": {
        "internal": ["http://127.0.0.1:3100/health", "http://127.0.0.1:3101/health"],
        "public": ["https://api.example.com/health"]
      },
      "allowTrackedFiles": []
    }
  }
}
```

Dans l'ordre : verrou (un seul déploiement à la fois ; le verrou d'un
processus mort est repris), refus d'un arbre non commité, refus d'une autre
branche que `branch`, refus d'un fichier secret suivi par git (`.env`,
`.env.*` sauf `.example/.sample/.template`, clés `.p8/.pem/.p12/.jks/.keystore`,
`id_rsa`…, JSON de compte de service — `secretPatterns` remplace la liste,
`allowTrackedFiles` excepte un chemin précis), `preSteps` (les tests), `git
push`, vérification que `HEAD` est bien `remote/branch`, puis sur le serveur
(`ssh host bash -s`, script sur l'entrée standard, valeurs en arguments
quotés) : `git fetch` + `reset --hard <commit>`, installation seulement si un
fichier de dépendances a bougé, rechargement, santé interne avec relances, et
**retour au commit précédent** sur toute panne (installation, rechargement ou
santé), dépendances réinstallées si besoin. Enfin la santé publique, depuis la
machine locale. Codes : `DEPLOY_DIRTY_TREE`, `DEPLOY_WRONG_BRANCH`,
`DEPLOY_SECRET_TRACKED`, `DEPLOY_PRESTEP_FAILED`, `DEPLOY_PUSH_FAILED`,
`DEPLOY_TARGET_NOT_PUSHED`, `DEPLOY_ROLLED_BACK`, `DEPLOY_ROLLBACK_FAILED`,
`DEPLOY_REMOTE_FAILED`, `DEPLOY_SSH_FAILED`, `DEPLOY_PUBLIC_UNHEALTHY`,
`DEPLOY_LOCKED`.

`deploy:health` lit la même section, plus `status` :
`{ "pm2Apps": ["api", "ai"], "backupLog": "/home/app/backup.log", "backupPattern": "backup sent", "backupMaxAgeDays": 1 }`.

## Publication mobile (`publish`)

`publish ios|android|all|update --dry-run` affiche le projet, la cible et les
choix d'envoi sans lire les clés ni modifier les versions, ni contacter Expo ou
les stores. `eas.maxViewFailures` règle le nombre d'échecs consécutifs admis
pour la lecture du statut (5 par défaut). Un fichier Apple présent mais
invalide fait échouer la publication ; seul l'absence de clé déclenche le
repli Transporter. Un transfert manuel ne marque pas l'empreinte comme publiée :
après livraison effective sur le store, utiliser `publish:fingerprint --record`.
Lorsque `versionBump` vaut `false`, relever soi-même la version de l'app avant
un build avec changement natif. `publish.version` peut fournir la version Expo
effective quand elle est déclarée ailleurs que dans `package.json`.

```json
{
  "publish": {
    "appName": "MonApp",
    "projectDir": "apps/mobile",
    "fingerprintFile": "scripts/.empreinte-native-publiee",
    "versionBump": "patch",
    "eas": { "profile": "production", "channel": "production" },
    "downloadsDir": "~/Downloads",
    "android": { "packageName": "com.exemple.app", "track": "internal", "serviceAccountPath": "play-service-account.json" },
    "ios": { "ascEnvFile": "~/.appstoreconnect/monapp.env", "bundleId": "com.exemple.app", "fallback": "transporter" }
  }
}
```

- **Version automatique** : l'empreinte native (`@expo/fingerprint`, pair
  optionnel, ou `fingerprint.command`) est comparée à celle du dernier build
  publié ; si elle diffère, `package.json` (et `package-lock.json`) montent
  d'un cran. À utiliser avec `runtimeVersion: { policy: "appVersion" }` —
  un avertissement s'affiche sinon.
- **Android** : JWT RS256 signé avec `node:crypto`, puis édition Google Play :
  création → envoi du `.aab` → piste → validation ; une édition ouverte avant
  une panne est supprimée. Codes `PLAY_KEY_MISSING`, `PLAY_KEY_INVALID`,
  `PLAY_TOKEN_REFUSED`, `PLAY_EDIT_FAILED`, `PLAY_UPLOAD_FAILED`,
  `PLAY_TRACK_FAILED`, `PLAY_COMMIT_FAILED`, `PLAY_NETWORK`.
  `"upload": "manual"` ouvre la Play Console à la place.
- **iOS** : la clé (`ASC_KEY_ID`, `ASC_ISSUER_ID` lus dans le fichier — lu,
  jamais exécuté — ou l'environnement ; `AuthKey_<id>.p8` cherché dans les
  dossiers d'altool) est vérifiée par un appel ES256 à `/v1/apps` **avant**
  le build, puis `xcrun altool --upload-app` envoie le `.ipa` (une erreur
  `ITMS-` fait échouer même si altool sort en 0). Sans clé : Transporter
  s'ouvre avec le fichier (`fallback: "none"` pour échouer).
- **Build local** : `"eas": { "mode": "local" }` fabrique sur la machine
  (`eas build --local`, Xcode pour iOS, JDK 17 et SDK Android pour Android)
  au lieu d'attendre la file d'Expo ; l'archive est écrite dans
  `downloadsDir` sous un nom provisoire puis renommée, puis envoyée comme un
  build EAS. `eas.localWorkDir` (par exemple un disque externe) reçoit le
  dossier de travail, vidé avant et après chaque build. Le nom du fichier
  porte l'heure du build (`local-AAAAMMJJ-HHMM`) à la place du numéro.
  Code `EAS_LOCAL_BUILD_FAILED` ; un mode inconnu (`PUBLISH_BUILD_MODE_INVALID`)
  arrête tout avant la montée de version.
- **update** : `eas update` seul, message = dernier commit si absent.
- `all` s'arrête à la première plateforme en échec ; l'empreinte est
  enregistrée dès qu'une plateforme est passée.

Aucun secret n'est affiché ni journalisé : clés par chemin de fichier ou nom de
variable d'environnement, jeton Google et identifiants Apple masqués dans les
erreurs et la sortie d'altool.

## Commandes à distance (`dispatch:generate`)

Produit le script d'une clé SSH à commande forcée : la clé ne peut lancer
que les actions listées.

```json
{
  "dispatch": {
    "installPath": "/Users/moi/bin/actions-distantes.sh",
    "publicKeyFile": "keys/iphone.pub",
    "logDir": "~/Library/Logs/actions-distantes",
    "path": ["/opt/homebrew/bin", "/usr/bin", "/bin"],
    "notify": "macos",
    "statusAction": "etat",
    "actions": [
      { "name": "deployer", "cwd": "~/projets/app", "command": ["npx", "astratra", "deploy", "--remote"] },
      { "name": "sante", "cwd": "~/projets/app", "command": ["npx", "astratra", "deploy:health"], "background": false }
    ]
  }
}
```

Le nom reçu (`$SSH_ORIGINAL_COMMAND`) doit valoir `^[a-z][a-z0-9-]{0,63}$`
en entier, sinon il est **refusé** (jamais « nettoyé » en un nom valide), puis
égaler une entrée d'un `case` figé. Les actions longues partent en arrière-plan
avec verrou par action (repris si son processus est mort, libéré même si le
dossier manque), journal horodaté et notification ; `etat` montre la fin de
chaque journal. La ligne `authorized_keys` produite :
`command="…",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding <clé>`.
Rien n'est installé dans `~/.ssh` : la ligne est affichée.

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

## Évaluer une IA (`eval`)

Mesure un fournisseur ou un modèle sur **un jeu de cas** avec
[promptfoo](https://github.com/promptfoo/promptfoo) (MIT). `promptfoo` est une
*devDependency* (pair optionnel) : `npm install --save-dev promptfoo`, Node 22.22
ou plus. Tout reste local : télémétrie, vérification de mise à jour et partage en
ligne sont coupés, et rien n'est écrit dans l'historique de promptfoo.

1. Écris `evals/cases.json` (exemple complet : `examples/eval-cases.example.json`) :

```json
{
  "prompt": "Tu es l'assistant d'une école. Réponds en français.\n\nQuestion : {{question}}",
  "cases": [
    {
      "description": "Capitale de la RDC",
      "vars": { "question": "Quelle est la capitale de la République démocratique du Congo ?" },
      "assert": [{ "type": "icontains", "value": "Kinshasa" }]
    }
  ]
}
```

Les assertions sont celles de promptfoo (`icontains`, `not-icontains`, `javascript`,
`llm-rubric`…). Un cas **sans assertion est refusé** : il réussirait toujours et
fausserait le taux.

2. Lance :

```bash
# Un modèle servi par llama.cpp (voir @astratra/ai (fournisseur llama.cpp)), la clé lue dans LLAMA_API_KEY :
astratra eval --provider=openai:chat:local --base-url=http://127.0.0.1:8080/v1 --api-key-env=LLAMA_API_KEY --min-pass=0.9
# Un fournisseur promptfoo quelconque :
astratra eval --provider=openai:chat:gpt-… --cases=evals/orthographe.json
```

ou fixe-les dans `astratra.config.json` :

```json
{ "eval": { "cases": "evals/cases.json", "minPassRate": 0.9,
            "providers": [{ "id": "openai:chat:local", "baseUrl": "http://127.0.0.1:8080/v1", "apiKeyEnv": "LLAMA_API_KEY" }] } }
```

La commande écrit la configuration promptfoo dans `.astratra-evals/promptfooconfig.json`
(sans aucune clé : seul le **nom** de la variable d'environnement y figure) et le
résultat dans `.astratra-evals/last-result.json`, affiche un score par fournisseur
avec les cas ratés et leur raison, et sort en **1** si un fournisseur passe sous
`minPassRate` (défaut 1, soit tous les cas) — utilisable en CI. Une erreur
d'exécution (réseau, serveur arrêté) compte comme un échec, pas comme un succès.

## Tests

```bash
npm test --workspace @astratra/tooling
```
