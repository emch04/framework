# Publication npm

Les paquets Astratra sont publiés depuis le poste de développement, par le
compte npm `emch99`, avec `scripts/publish-all.sh`. C'est la seule méthode
réellement utilisée : aucune version en ligne ne porte de provenance npm.

## Versions : plus de 0.x

Depuis le 1er octobre 2026, tous les paquets sont en 1.x ou plus.

- **Un nouveau paquet naît en `1.0.0`**, jamais en `0.x`.
- Correctif sans changement d'API : version de correctif (`1.2.3` → `1.2.4`).
- Ajout rétrocompatible (nouvelle fonction, nouvelle option) : version
  mineure (`1.2.3` → `1.3.0`).
- Rupture (signature changée, export retiré, comportement par défaut
  modifié) : version majeure (`1.2.3` → `2.0.0`), décrite sous « Rupture »
  dans `CHANGELOG.md`.
- Un paquet dont le contenu publié ne change pas garde sa version. Pour savoir
  si un paquet a changé depuis sa publication, comparer
  `npm pack --dry-run --json` (champ `shasum`) à `npm view <nom> dist.shasum`.
- Les dépendances internes s'écrivent en caret sur une 1.x (`"^1.0.0"`), qui
  suit les mineures. Un caret sur une `0.x` ne franchissait pas la mineure
  (`^0.2.0` n'installait jamais la `0.3.0`) : c'est la raison du passage en 1.x.

## Avant de publier

1. Monter la version dans le `package.json` du paquet selon les règles
   ci-dessus et l'inscrire dans `CHANGELOG.md`.
2. Si un paquet voisin doit exiger cette nouvelle version, relever son
   plancher. Idem pour les planchers écrits par `create-astratra-app`
   (`src/bricks.js`, `src/createProject.js`, gabarit mobile) ; ses tests
   comparent chaque plancher aux versions du dépôt. Changer ces planchers
   change le paquet publié : monter aussi sa version mineure.
3. `npm install` à la racine pour mettre `package-lock.json` à jour.
4. Un nouveau paquet s'ajoute à `ORDER` dans `scripts/publish-all.sh`, après
   toutes ses dépendances internes (le script refuse de démarrer sinon).
   `scripts/verify-package-installation.js` lit `packages/` tout seul.
5. Tout vérifier depuis la racine :

```bash
npm test && npm run lint && npm run typecheck && npm run verify:packages
```

6. Contrôler chaque archive qui partira :

```bash
npm pack --dry-run --workspace @astratra/<nom>
```

   Elle ne doit contenir que ce que liste `files` : pas de `__tests__`, pas de
   `.env`, de clé ni de jeton, pas de fichiers de travail. Deux paquets sont
   lourds par nature : `@astratra/models` (catalogue des prix, environ 3 Mo
   décompressé) et `@astratra/ledger` (plans comptables et taxes).
7. Licences : toute donnée ou tout code repris d'un tiers est accompagné de
   son fichier `NOTICE` dans le paquet, et ce fichier figure dans `files`.
   Dépendances MIT, Apache 2.0 ou BSD seulement ; LGPL uniquement comme
   fichier de données séparé et mentionné ; rien de GPL, AGPL, BSL, ELv2 ou
   FSL.
8. `npm audit --omit=dev` à la racine : aucune vulnérabilité haute ou
   critique dans les dépendances de production.

## Ordre de publication

Un paquet part après toutes ses dépendances internes (`dependencies`,
`peerDependencies`, `devDependencies`, `optionalDependencies`), et
`create-astratra-app` en dernier car ses gabarits réclament les autres.
L'ordre de `ORDER` dans `scripts/publish-all.sh`, calculé le 1er octobre 2026
par tri topologique des dépendances réelles :

1. `@astratra/core`
2. `@astratra/security` (core)
3. `@astratra/rag`
4. `@astratra/credentials` (core, security)
5. `@astratra/entitlements`
6. `@astratra/notify`
7. `@astratra/client`
8. `@astratra/native` (client)
9. `@astratra/native-ui` (native)
10. `@astratra/payments`
11. `@astratra/privacy`
12. `@astratra/resilience`
13. `@astratra/ai` (core ; resilience en développement)
14. `@astratra/memory` (ai en développement)
15. `@astratra/models`
16. `@astratra/i18n-server`
17. `@astratra/pdf`
18. `@astratra/loyalty`
19. `@astratra/wallet` (core)
20. `@astratra/closure`
21. `@astratra/app-version`
22. `@astratra/app-guide`
23. `@astratra/voice`
24. `@astratra/live` (voice, ai)
25. `@astratra/prerender`
26. `@astratra/react`
27. `@astratra/tooling` (core)
28. `@astratra/saas-kit` (ai, core, security)
29. `@astratra/saas-kit-ui`
30. `@astratra/store-mongo`
31. `@astratra/store-postgres`
32. `@astratra/booking`
33. `@astratra/collab`
34. `@astratra/fhir`
35. `@astratra/flags`
36. `@astratra/ledger` (store-postgres en développement)
37. `@astratra/repomap`
38. `@astratra/srs`
39. `@astratra/testkit`
40. `create-astratra-app` (planchers de ses gabarits : ai, core, saas-kit,
    security, store-mongo, saas-kit-ui, credentials, entitlements, notify,
    payments, privacy, resilience, i18n-server, pdf, closure, client,
    prerender, native)

Le script vérifie lui-même, avant toute publication, que chaque dépendance
interne est placée avant le paquet qui la réclame.

## Publier

Voir d'abord ce qui partirait :

```bash
bash scripts/publish-all.sh --dry-run
```

Puis publier :

```bash
bash scripts/publish-all.sh
```

Le script :

- publie seulement les paquets dont la version locale diffère de celle du
  registre, donc il se relance sans danger ;
- suit l'ordre des dépendances (`core` et `security` d'abord,
  `create-astratra-app` en dernier), pour qu'un projet installé pendant la
  publication ne réclame jamais une version encore absente ;
- refuse de démarrer si un dossier de `packages/` manque à sa liste `ORDER`.
  Un nouveau paquet doit y être ajouté à sa place dans l'ordre des
  dépendances ;
- refuse aussi de démarrer si un paquet de `ORDER` est placé avant une de
  ses dépendances internes ;
- s'arrête au premier échec, pour ne jamais publier un paquet qui réclame
  une version absente du registre ;
- compare la version exacte au registre, pas l'étiquette `latest`, que npm
  met quelques minutes à rafraîchir après une publication.

npm demande de valider chaque paquet : un lien « Authenticate your account
at… » à ouvrir dans le navigateur, ou le code 2FA. Le script laisse npm écrire
directement dans le terminal pour que cette demande reste visible ; un
échec E401 veut dire qu'il faut d'abord `npm login`. Un jeton
d'**automatisation** dans `~/.npmrc` évite la validation ; un jeton classique
ne suffit pas.

## Après

Pousser les commits sur `main` : une version publiée dont le code n'est pas
sur GitHub ne peut être relue par personne.

Secret Scanning et Push Protection doivent rester actifs dans les réglages de
sécurité du dépôt ; la CI Gitleaks complète ce contrôle, elle ne le remplace
pas. Une fausse clé de test s'écrit donc en morceaux assemblés à l'exécution
(voir `packages/privacy/__tests__/dlp.test.js`), jamais en entier : écrite
telle quelle, elle bloque le push.

## Workflow GitHub Actions (non utilisé)

`.github/workflows/publish.yml` publie un workspace avec provenance npm, sans
jeton npm dans GitHub. Il n'a jamais servi et ne fonctionnerait pas en l'état :

- aucun `package.json` ne déclare de champ `repository`, que la provenance
  exige pour relier le paquet au dépôt ;
- chaque paquet devrait être déclaré sur npm avec un **trusted publisher**
  GitHub Actions (compte `emch04`, dépôt `framework`, workflow
  `.github/workflows/publish.yml`, environnement `npm`), et l'environnement
  `npm` créé dans GitHub avec validation manuelle ;
- le compte GitHub doit pouvoir lancer des Actions : en septembre 2026, il est
  bloqué pour un problème de facturation, et aucune CI ne tourne.
