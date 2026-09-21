# Publication npm

Les paquets Astratra sont publiés depuis le poste de développement, par le
compte npm `emch99`, avec `scripts/publish-all.sh`. C'est la seule méthode
réellement utilisée : aucune version en ligne ne porte de provenance npm.

## Avant de publier

1. Monter la version dans le `package.json` du paquet (mineure pour un ajout,
   majeure pour une rupture) et l'inscrire dans `CHANGELOG.md`.
2. Si un paquet voisin doit exiger cette nouvelle version, relever son
   plancher. Un caret sur une `0.x` ne franchit pas la mineure : `^0.2.0`
   n'installe jamais la `0.3.0`. Idem pour les planchers écrits par
   `create-astratra-app` (`src/bricks.js`, `src/createProject.js`, gabarit
   mobile) ; ses tests comparent chaque plancher aux versions du dépôt.
3. Tout vérifier depuis la racine :

```bash
npm test && npm run lint && npm run typecheck && npm run verify:packages
```

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
