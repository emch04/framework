# @astratra/centrale-cli

L'outil en ligne de commande d'un tableau de bord de surveillance auto-hébergé : il relie les erreurs minifiées à leur vraie ligne (cartes de code, par identifiant de débogage) et déclare les déploiements (version d'apparition, commit suspect). Aucune dépendance, aucun outil Sentry.

## Commandes

```sh
export CENTRALE_ADRESSE=https://centrale.exemple.fr
export CENTRALE_JETON=clj_dep_…            # jeton de DÉPLOIEMENT du projet (secret de CI)

npx centrale injecter dist                 # après le build, avant la mise en ligne
npx centrale envoyer-cartes dist --version 2.14.0
npx centrale deploiement --version 2.14.0 --commit "$GITHUB_SHA" --depot exemple/app --environnement production
```

| Commande | Ce qu'elle fait |
| --- | --- |
| `injecter <dossier>` | Pour chaque `.js`/`.mjs`/`.cjs` qui a une carte (commentaire `sourceMappingURL` ou `<fichier>.map`) : calcule un identifiant stable (SHA-256 du contenu, mis en forme d'UUID), insère en tête une ligne qui l'enregistre dans `globalThis.__centraleDebugIds`, ajoute `//# debugId=<id>` en fin de fichier et `debug_id` dans la carte. Relancer ne change rien. |
| `envoyer-cartes <dossier> --version X` | Demande au backend les cartes qu'il a déjà, puis envoie les autres par lots compressés (16 Mio visés, 64 Mio au plus). Coupure, 5xx et 429 sont réessayés avec recul (`Retry-After` respecté). Relancer reprend où l'envoi s'est arrêté. |
| `deploiement --version X --commit SHA` | Déclare un déploiement. `--environnement` vaut par défaut celui du jeton. Déclarer deux fois le même ne crée pas de doublon. |

Codes de sortie : `0` réussi, `1` échec (réseau, jeton refusé, carte refusée), `2` commande mal formée.

## Comment l'identifiant voyage

1. `injecter` place en tête de chaque fichier (après `#!` et les directives `"use strict"`, `"use client"`, sur la même ligne pour ne décaler aucun numéro de ligne ; les colonnes de la carte sont recalées) :
   `globalThis.__centraleDebugIds[new Error().stack] = "<id>"`.
2. Au chargement, la pile capturée contient l'adresse réelle du fichier (domaine, hash du build compris).
3. `@astratra/centrale` relit ces piles avec le même analyseur que les erreurs : chaque cadre reçoit le `debugId` de son fichier (et l'erreur aussi, s'il n'y en a qu'un).
4. Le backend traduit les cadres avec la carte de même identifiant **du même projet**, à la lecture du détail d'un problème.

Sans identifiant (bytecode Hermes, build non injecté), le backend cherche une carte de **la même version** dont le chemin finit comme celui du cadre : nommez la carte comme le fichier des piles (par exemple `index.android.bundle.map` pour Expo/React Native).

## Exemples de build

- **Vite / Astro** : `build.sourcemap: true` (ou `'hidden'` pour ne pas publier le commentaire), puis `centrale injecter dist`. Ne mettez pas les `.map` en ligne : supprimez-les après `envoyer-cartes`.
- **Node compilé** (tsc, esbuild) : `sourceMap: true`, puis `centrale injecter build`.
- **Expo / Hermes** : exportez avec les cartes (`npx expo export --dump-sourcemap`), puis `centrale injecter dist` (la carte reçoit son identifiant) et `centrale envoyer-cartes dist --version <version de l'app>`.

## Bibliothèque

```ts
import { injecterDossier, envoyerCartes, declarerDeploiement } from '@astratra/centrale-cli';
```

Le paquet est écrit en TypeScript à syntaxe effaçable (Node 24 l'exécute directement dans le dépôt) ; il sera compilé en JavaScript au moment de sa publication, comme `@astratra/centrale`.

## Tests

```sh
npm test -w @astratra/centrale-cli
```
