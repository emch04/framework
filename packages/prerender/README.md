# @astratra/prerender

Prérendu SEO générique pour un site Vite + React. Il génère une page HTML par
route et conserve `dist/_shell.html` pour servir le shell SPA aux visiteurs.

## Installation

```bash
npm install -D @astratra/prerender playwright vite
```

## Configuration

Créez `astratra.prerender.config.cjs` :

```js
module.exports = {
  distDir: 'dist',
  siteUrl: 'https://example.com',
  routes: ['/', '/about', '/pricing'],
  waitFor: 'meta[name="description"]'
};
```

Puis ajoutez `vite build && astratra-prerender` à votre script `build`.

## Options

- `distDir` : dossier produit par Vite ; défaut `dist`.
- `routes` : URLs statiques à générer ; obligatoire.
- `siteUrl` : URL publique utilisée dans le HTML généré ; obligatoire.
- `waitFor` : sélecteur CSS présent dans le DOM avant la capture de chaque
  page (`state: 'attached'` — pas la visibilité par défaut de Playwright, qui
  n'aboutirait jamais pour un élément sans rendu visuel comme une balise
  `<meta>`).
- `apiPatterns` : motifs Playwright bloqués avec `{}` ; défaut `['**/api/**']`.
  Remplace entièrement le défaut s'il est fourni, ne s'y ajoute pas — pour
  couvrir `/api/**` en plus d'un motif personnalisé, listez les deux motifs
  explicitement.
- `retries` : seconde tentative après un échec ; défaut `1`.
- `audit` : vérifie titre et description présents, titres et contenus visibles
  non dupliqués entre pages, avertit (sans bloquer) sur un contenu trop
  mince ; défaut `true`.
- `transformHtml(html, context)` : transforme le HTML d'un projet avant écriture.
- `isReady(page, route)` : attente asynchrone propre au projet avant capture.

## CLI

```bash
astratra-prerender
astratra-prerender --config config/prerender.js
```

Sans option, la commande lit `astratra.prerender.config.cjs` à la racine du
projet. Elle doit être exécutée après `vite build` : le package copie d'abord
le shell non rendu dans `dist/_shell.html`, puis écrit le HTML SEO des routes.

Les routes privées, paramétrées ou nécessitant une session ne doivent pas être
placées dans `routes`. `apiPatterns` bloque les appels API avec une réponse JSON
vide. `transformHtml(html, context)` et `isReady(page, route)` permettent une
adaptation par projet sans modifier le framework.
