# Astratra Prerender Design

## Objectif

Créer `@astratra/prerender` afin qu'un site React/Vite puisse générer des pages
HTML statiques sans embarquer de règles métier, de routes ou de domaine propres
à une application donnée.

## Périmètre V1

Le package cible uniquement Vite et React. Il démarre Vite Preview après le
build, utilise Playwright pour charger une liste explicite de routes, écrit un
`index.html` par route dans `dist`, et conserve une copie vierge du shell SPA
sous `dist/_shell.html`.

Le consommateur fournit une configuration JavaScript :

```js
const { prerender } = require('@astratra/prerender');

await prerender({
  distDir: 'dist',
  routes: ['/', '/about', '/pricing'],
  siteUrl: 'https://example.com',
  apiPatterns: ['**/api/**'],
  waitFor: 'meta[name="description"]'
});
```

`routes` est obligatoire. `siteUrl` sert uniquement à remplacer l'origine du
serveur local dans le HTML produit. Aucune route n'est devinée ou lue depuis le
routeur React : un framework ne doit pas imposer une forme de routeur.

## Architecture

`src/prerender.js` orchestre le serveur Vite, Playwright, les tentatives et
l'écriture des fichiers. `src/html.js` contient uniquement des fonctions pures
pour nettoyer le HTML, remplacer l'origine locale et vérifier qu'un shell n'a
pas déjà été prérendu. `src/audit.js` contient l'audit de titre, description,
contenu mince et contenu dupliqué.

Le package ne connaît ni fournisseur d'hébergement, ni bibliothèque de meta
tags, ni format de routeur. Les projets peuvent fournir `transformHtml(html, context)`
pour appliquer leurs propres suppressions de balises ou normalisations avant
l'écriture, et `isReady(page)` pour définir quand leur application React a fini
de rendre.

## Comportement de sûreté

Le prérendu refuse un `dist/index.html` déjà rendu, afin de ne jamais écraser le
shell SPA. Les appels réseau correspondant à `apiPatterns` reçoivent une réponse
JSON vide, les WebSockets sont bloqués par défaut, et les routes qui échouent
après les tentatives configurées font échouer le prérendu complet.

L'audit est actif par défaut : chaque page doit avoir un `title` et une meta
description. Les titres identiques et les contenus presque identiques font
échouer la génération ; le contenu mince produit un avertissement. Ces règles
peuvent être désactivées ou ajustées explicitement dans `audit`.

## Commande

Le binaire `astratra-prerender` lit par défaut `astratra.prerender.config.cjs` à
la racine du projet. Il accepte `--config <chemin>`. Le package expose aussi la
fonction `prerender()` pour les projets qui préfèrent l'appeler depuis leur
propre script de build.

## Dépendances et publication

`playwright` et `vite` sont des peer dependencies optionnelles avec des erreurs
explicites si elles manquent. Le package reste CommonJS, comme les autres
packages Astratra. Il sera publié sous `@astratra/prerender` en `0.1.0`, car il
introduit un nouveau package et doit encore être éprouvé sur de vrais sites.

## Documentation

Le README du package est en français et documente l'installation, la commande
CLI, chaque option de `prerender()`, le format du fichier de configuration, la
place du prérendu dans un script `build`, le shell SPA et les limites de la V1.
Il contient un exemple complet d'un site Vite/React monopage et explique que
les routes privées, paramétrées ou dépendantes d'une session ne doivent pas
être prérendues par défaut.

## Tests

Les fonctions HTML et d'audit ont des tests unitaires sans navigateur. Un test
d'intégration crée un mini site Vite, exécute le prérendu, vérifie les fichiers
de routes et `_shell.html`, puis confirme qu'un échec de route annule la
génération. Les tests n'utilisent pas Docker.
