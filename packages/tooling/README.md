# @astratra/tooling

CLI pour l'audit et les tâches génériques de maintenance de projet. Fournit
un binaire `astratra`. Dépend de `@astratra/core`.

Rien dans ce package ne connaît la structure de dossiers, les noms de rôles
ou la cible de déploiement d'un projet précis — chaque chemin et pattern a
une valeur par défaut neutre, surchargeable via `astratra.config.json` (ou
`.js`) à la racine du projet consommateur.

## Commandes

```bash
astratra audit:secrets [--dir=<path>]   # détecte les secrets littéraux loggés ou renvoyés dans des réponses API
astratra audit:routes  [--dir=<path>]   # détecte les routes Express *.routes.js sans middleware d'auth apparent
astratra audit:i18n    [--dir=<path>]   # détecte les incohérences de clés de traduction entre langues
astratra test                           # lance le script 'test' de chaque workspace et agrège le résultat
astratra deploy [--mode=<name>]         # exécute les étapes de déploiement définies dans votre propre config — aucune logique de déploiement intégrée
```

Chaque commande retourne un exit code non-zéro en cas de findings/échecs —
utilisable directement en CI.

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
    "i18n": { "localesDir": "locales", "sourceDirs": ["src"] }
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

## Tests

```bash
npm test --workspace @astratra/tooling
```
