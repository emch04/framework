# Astratra — Design @astratra/tooling (V0)

## Contexte

Deuxième package du monorepo Astratra (voir
`2026-08-08-astratra-core-design.md` pour le contexte global). `@astratra/tooling`
fournit un CLI `astratra` avec des commandes d'audit, de test et de déploiement,
extraites puis généralisées depuis des scripts internes d'audit et de test.

Contrainte stricte : rien de spécifique au projet source (pas de chemins VPS,
pas de noms de service pm2, pas de dossiers internes en dur). Tout doit être
configurable via un fichier `astratra.config.json` (ou `.js`) à la racine du projet
consommateur, avec des valeurs par défaut raisonnables.

Le script de déploiement d'origine est trop spécifique (VPS, pm2, chemins
absolus) pour être porté tel quel — ne pas l'extraire. À la
place, fournir une commande `deploy` générique : elle exécute une séquence
d'étapes définies dans la config du projet (build → healthcheck → hooks
avant/après), sans connaître le mécanisme de déploiement réel (le projet
consommateur branche ses propres commandes shell dans la config).

## Package : @astratra/tooling

CLI exécutable `bin/astratra.js` (déclaré dans `package.json` → `bin`), dépend de
`@astratra/core` pour `AppError`/`createLogger`.

Commandes V0 :

1. `astratra audit:secrets [--dir=<path>]`
   Détecte les secrets littéraux (clés API, tokens, mots de passe) dans les
   logs/réponses API. Généralisé depuis `scripts/audit_secret_leaks.js` :
   dossiers cibles par défaut = `["src"]`, mais lisibles depuis
   `astratra.config.json` → `audit.secrets.dirs`.

2. `astratra audit:routes [--dir=<path>]`
   Détecte les routes Express (`*.routes.js`) sans middleware d'auth apparent.
   Généralisé depuis `scripts/audit_route_permissions.js` : la regex des noms
   de middleware d'auth et les dossiers cibles doivent être configurables
   (`audit.routes.authMiddlewarePatterns`, `audit.routes.dirs`), pas hardcodés
   sur les noms du projet source (`authorizeRoles`, `proxyAuth`, etc. restent la valeur
   par défaut, mais un projet doit pouvoir les redéfinir).

3. `astratra audit:i18n [--dir=<path>]`
   Vérifie la cohérence des clés de traduction entre langues. Généralisé depuis
   `scripts/audit_i18n_consistency.js`.

4. `astratra test`
   Lance les suites de tests de tous les workspaces npm du projet consommateur
   (détecte les `package.json` avec un script `test`), agrège le résultat.
   Généralisé depuis `scripts/test-runner.js` (qui, lui, listait les workspaces
   projet source en dur — à remplacer par une détection automatique via
   `workspaces` du `package.json` racine, ou une liste dans
   `astratra.config.json` → `test.workspaces`).

5. `astratra deploy [--mode=<name>]`
   Exécute la séquence définie dans `astratra.config.json` → `deploy.steps`
   (tableau ordonné de commandes shell) et `deploy.modes` (ex. `fast` skip
   certaines étapes). Ne contient aucune commande de déploiement réelle par
   défaut — juste l'orchestrateur (logs, arrêt au premier échec, résumé final).

Chaque commande :
- retourne un exit code non-zéro en cas de findings/échecs (utilisable en CI)
- affiche un résumé lisible en console (reprendre le style existant : couleurs
  ANSI simples, pas de dépendance lourde comme chalk)

## Configuration

`astratra.config.json` optionnel à la racine du projet consommateur. Si absent,
valeurs par défaut raisonnables (dossier `src`, pas d'étapes de deploy, etc.).
Le chargement de cette config doit utiliser `@astratra/core`.

## Tests

Tests unitaires Jest pour chaque commande (mock du filesystem avec des fixtures
temporaires, pas de dépendance à un vrai projet externe). Pas de test end-to-end
du binaire CLI complet nécessaire pour la V0 — tester la logique exportée par
chaque module.

## Hors périmètre V0

- `docker` (génération de Dockerfile) : reporté à plus tard, pas dans ce spec.
- Parité complète avec `deploy_production.sh` : explicitement refusée (voir
  Contexte).
