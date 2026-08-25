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
- `routes` : URLs statiques à générer ; obligatoire. Une simple chaîne, ou une
  ligne de table `{ path, label?, lastmod?, changefreq?, priority?, sitemap? }`
  quand tu veux aussi un plan de site.
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
- `sitemap` : écrit `dist/sitemap.xml` depuis `routes` ; défaut `false`.
  `true`, ou `{ path?, defaultLastmod? }`. Laissé à `false`, un
  `dist/sitemap.xml` déjà présent est relu sans être touché et ses URLs sans
  page remontent dans `warnings`.
- `transformHtml(html, context)` : transforme le HTML d'un projet avant écriture.
- `isReady(page, route)` : attente asynchrone propre au projet avant capture.


## Le sitemap, tiré de la même liste que les pages

Un sitemap est presque toujours un fichier écrit à la main, sans lien avec la
liste des routes — et les deux finissent par diverger. La panne est silencieuse
et coûteuse : le fichier dit à un robot d'aller chercher une URL jamais
prérendue, l'hébergeur retombe sur son repli SPA, et le robot reçoit la **page
d'accueil** — titre et description compris — sous cette adresse.

C'est exactement le doublon que `auditPages` détecte du côté du rendu. Le
sitemap ferme le même trou du côté de l'annonce.

```js
prerender({
  siteUrl: 'https://www.example.cd',
  routes: [
    { path: '/',        label: 'Accueil', changefreq: 'daily',   priority: '1.0' },
    { path: '/pricing', label: 'Tarifs',  changefreq: 'monthly', priority: '0.9' },
    // Rendue pour un robot qui suit un lien, sans mériter sa place au plan de site.
    { path: '/login',   sitemap: false },
  ],
  sitemap: true,   // écrit dist/sitemap.xml
});
```

Une route reste acceptée sous forme de simple chaîne : `routes: ['/', '/about']`
fonctionne comme avant. La forme objet n'est utile que si tu veux un sitemap ou
des métadonnées éditoriales.

`lastmod`, `changefreq` et `priority` sont des choix éditoriaux ; `lastmod`
prend la date du jour par défaut, ou celle de `sitemap.defaultLastmod`.

### Pourquoi c'est optionnel

`sitemap` vaut `false` par défaut, et c'est délibéré : beaucoup de projets ont
déjà un `public/sitemap.xml` recopié dans `dist` par Vite. L'écraser sans qu'on
l'ait demandé serait une surprise destructrice.

En revanche, si un `dist/sitemap.xml` existe et que tu ne demandes pas de
génération, il est **relu sans être touché** : toute URL qu'il annonce sans page
derrière remonte dans `warnings`. C'est ainsi qu'on découvre qu'il réclame
encore une page retirée du prérendu il y a six mois.

Un avertissement, pas une erreur : un site parfaitement sain peut lister des
URLs rendues ailleurs — pages serveur, contenu dynamique — dont ce prérendu n'a
aucune connaissance.

### Fonctions exportées

`buildSitemap(routes, { siteUrl, defaultLastmod })` et
`auditSitemap(xml, cheminsRendus, siteUrl)` sont exportées telles quelles, pour
qui préfère garder son propre pipeline et n'emprunter que le contrôle.

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
