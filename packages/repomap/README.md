# @astratra/repomap

Génère une carte compacte d'un dépôt en classant les fichiers par importance des références entre symboles. L'analyse syntaxique utilise `web-tree-sitter` et les grammaires WASM JavaScript, TypeScript, TSX et Python de `tree-sitter-wasms`. Les extensions de langage sont centralisées pour permettre d'en ajouter.

```js
const { buildRepoMap } = require('@astratra/repomap');

const carte = await buildRepoMap(process.cwd(), {
  conversationFiles: ['src/server.ts'],
  mentionedIdentifiers: ['createServer'],
  budget: 1024,
});
console.log(carte.content);
```

Les chemins passés dans `conversationFiles` sont relatifs à la racine. `tokenCounter` permet d'injecter le compteur du modèle cible. Le cache transmis avec `cache` est réutilisable entre les appels et invalide chaque fichier selon sa date, sa taille et son empreinte SHA-1. Les fichiers exclus par `.gitignore`, les répertoires `node_modules`, `dist`, `.git`, `coverage`, `build` et les fichiers contenant des octets nuls ne sont pas analysés.

Le calcul PageRank distribue le score selon les références entrantes; les arêtes sont pondérées par la racine carrée du nombre de références, avec ajustements de fréquence des identifiants mentionnés, longueur des identifiants et préfixe privé. Les fichiers présents dans la conversation reçoivent ensuite un multiplicateur de 50.

API TypeScript : voir `src/index.d.ts`.

Inspiration méthodologique : `repomap.py` d'Aider, distribué sous licence Apache-2.0. Cette implémentation est indépendante et ne reprend pas son code.
