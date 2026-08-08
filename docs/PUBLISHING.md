# Publication npm

Les paquets Astratra publics sont publiés depuis GitHub Actions avec
provenance npm. Cette méthode évite de placer un token npm dans GitHub.

## Configuration initiale

Pour chaque paquet publié, ouvrez ses réglages sur npm, puis ajoutez un
**trusted publisher** de type GitHub Actions avec les valeurs suivantes :

- Organisation ou compte GitHub : `emch04`
- Dépôt : `framework`
- Fichier de workflow : `.github/workflows/publish.yml`
- Environnement : `npm`

Dans GitHub, créez l'environnement `npm` et protégez-le avec une validation
manuelle avant publication. Activez aussi Secret Scanning et Push Protection
dans les réglages de sécurité du dépôt : la CI Gitleaks complète ce contrôle,
elle ne le remplace pas.

## Publication

Après avoir modifié une version dans le workspace concerné et poussé sur
`main`, lancez **Publish npm package** dans l'onglet Actions. Choisissez le
workspace puis validez l'environnement `npm`.

Le workflow exécute `npm ci`, contrôle l'archive avec `npm pack --dry-run`,
puis lance :

```bash
npm publish --workspace "<workspace>" --access public --provenance
```

npm associe alors la publication au dépôt et au workflow. Aucun token npm
longue durée n'est nécessaire dans les secrets GitHub.
