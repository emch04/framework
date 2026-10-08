# @astratra/repomap

Génère une carte compacte d'un dépôt de code : pour chaque fichier important, les signatures de ses définitions, classées par importance des références entre symboles, et tronquées pour tenir dans un budget de jetons. Utile pour donner à un modèle de langage ou à un outil d'exploration un aperçu d'un dépôt trop gros pour être lu en entier.

L'analyse syntaxique utilise `web-tree-sitter` et les grammaires WASM JavaScript, TypeScript, TSX et Python de `tree-sitter-wasms`.

## Installation

```sh
npm install @astratra/repomap
```

Node 20 ou plus récent.

## Exemple

```js
const { buildRepoMap } = require('@astratra/repomap');

const carte = await buildRepoMap(process.cwd(), {
  conversationFiles: ['src/server.ts'],
  mentionedIdentifiers: ['createServer'],
  budget: 1024,
});

console.log(carte.content);   // le texte de la carte
console.log(carte.tokenCount, carte.files.length); // jetons utilisés, fichiers retenus
```

`buildRepoMap(racine, options?)` rend une promesse de `{ content, files, tokenCount, budget, cacheSize }`. Chaque entrée de `files` porte `path`, `rank`, `definitions` (`symbol`, `line`, `text`) et `lines`. Les types complets sont dans `src/index.d.ts`.

## Options

| Option | Rôle |
| --- | --- |
| `budget` | Nombre de jetons visé pour `content` (1024 par défaut). |
| `conversationFiles` | Chemins relatifs à la racine, déjà connus de l'appelant : leur score est multiplié par 50. |
| `mentionedIdentifiers` | Identifiants à favoriser dans le classement. |
| `languages` | Langages analysés parmi `javascript`, `typescript`, `tsx` et `python` (tous par défaut). |
| `tokenCounter` | `(texte) => nombre` : compteur injectable pour correspondre au tokenizer du modèle cible. |
| `cache` | `Map` réutilisable entre les appels ; chaque fichier est invalidé selon sa date, sa taille et son empreinte SHA-1. |
| `parserCache` | `Map` facultative d'instances d'analyseur. |
| `wasmDirectory` | Répertoire des grammaires WASM, si vous ne voulez pas celles de `tree-sitter-wasms`. |

Les fichiers exclus par `.gitignore`, les répertoires `node_modules`, `dist`, `.git`, `coverage`, `build` et les fichiers contenant des octets nuls ne sont pas analysés.

## Classement

Un calcul PageRank répartit le score selon les références entrantes. Les arêtes sont pondérées par la racine carrée du nombre de références, avec des ajustements pour les identifiants mentionnés, la longueur des identifiants et le préfixe privé. La fonction `pagerank(files, edges)` est aussi exportée.

## Ce que le paquet ne fait pas

- Il ne lit que JavaScript, TypeScript, TSX et Python ; les autres fichiers n'apparaissent pas dans la carte.
- Il ne résume pas le code et n'appelle aucun modèle : il extrait et classe des signatures.
- Le compteur par défaut compte les mots (identifiants), pas les jetons d'un modèle ; fournissez `tokenCounter` si le budget doit être exact.

## Licence

MIT.
