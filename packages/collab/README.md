# @astratra/collab

Édition collaborative en temps réel, pour un wiki (le module « Connaissances »
de Cortex) ou tout document partagé : plusieurs personnes écrivent dans le
même texte en même temps, chacune voit les autres en direct, et personne
n'écrase personne.

Le paquet assemble des briques libres (licence MIT) éprouvées :

- **Yjs** : le format de document partagé (un CRDT : les modifications
  simultanées fusionnent toujours vers le même résultat, sans arbitre) ;
- **Hocuspocus** : le serveur WebSocket qui relaie et enregistre ces documents ;
- **Tiptap** : l'éditeur de texte riche côté navigateur.

Ce qu'il ajoute : le branchement sur ton authentification (droit lecture ou
écriture **par document**), une persistance injectable avec instantanés,
l'historique de versions avec restauration, des limites de taille, et les
conversions Yjs ↔ JSON / Markdown / HTML / texte pour la recherche et l'export.

Aucune extension Tiptap payante (« Pro ») n'est utilisée.

## Installation

```bash
npm install @astratra/collab
```

Node 20.19 ou plus récent (le Markdown passe par `marked`, publié en module
ES uniquement, que Node charge depuis `require` à partir de cette version).

## Serveur

```js
const { createCollabServer, createPostgresPersistence } = require('@astratra/collab');

const collab = createCollabServer({
  // Le jeton envoyé par le client, le document demandé : à toi de décider.
  async authenticate({ token, documentName }) {
    const session = await sessions.verify(token);
    if (!session) return 'none';
    const page = await wiki.findPage(documentName);
    if (!page || page.tenantId !== session.tenantId) return 'none';
    return {
      access: page.editors.includes(session.userId) ? 'write' : 'read',
      user: { id: session.userId, name: session.name }
    };
  },
  persistence: createPostgresPersistence({ pool }),
  limits: { maxDocumentBytes: 5 * 1024 * 1024, maxMessageBytes: 1024 * 1024 }
});

const { url } = await collab.listen(1234);
```

`authenticate` peut répondre court (`'write'`, `'read'`, `'none'`, `true`,
`false`) ou long (`{ access, user, context }`). Une exception vaut refus.

- **écriture** : la connexion modifie le document ;
- **lecture** : la connexion reçoit tout en direct, mais le serveur ignore ce
  qu'elle envoie — même un client modifié ne peut rien écrire ;
- **refus** : rien n'est envoyé, le client reçoit `permission-denied`.

Derrière un proxy (nginx, Cloudflare), le serveur parle WebSocket : prévois
l'en-tête `Upgrade` sur la route choisie.

### Limites de taille

| Limite | Défaut | Effet |
| --- | --- | --- |
| `maxMessageBytes` | 1 Mio | un message plus gros coupe la connexion, il n'est pas appliqué |
| `maxDocumentBytes` | 5 Mio | une modification qui ferait dépasser le document est refusée |

Le client fourni par ce paquet reconnaît ces coupures, **arrête de se
reconnecter** (sinon il renverrait le même contenu en boucle) et appelle
`onLimitExceeded`.

### Historique de versions

```js
const v = await collab.createVersion('wiki/accueil', { label: 'Validée par la direction', author: user.id });
await collab.listVersions('wiki/accueil');        // la plus récente d'abord, sans les instantanés
await collab.restoreVersion('wiki/accueil', v.id, { author: user.id });
// → { restoredFrom, backup }
```

Une version est un instantané Yjs complet. La restauration :

1. sauvegarde d'abord l'état courant en version `backup` — une restauration
   se défait donc comme n'importe quoi d'autre ;
2. remplace le contenu **à l'intérieur** du document partagé : les personnes
   connectées voient le texte revenir, sans déconnexion ni rechargement.

Elle restaure les fragments listés dans `fields` (`['default']`, celui de
Tiptap). Si tu ranges d'autres données dans le même document Yjs (un titre
dans une `Y.Map`, par exemple), ajoute-les toi-même.

### Persistance

Trois implémentations, toutes au même contrat :

```js
createMemoryPersistence();                                     // tests, développement
createPostgresPersistence({ pool });                           // tables créées au premier usage (bytea)
createMongoPersistence({ db: mongoose.connection });           // ou un Db du pilote mongodb
```

Pour une autre base, fournis un objet avec ces cinq méthodes asynchrones :

```ts
load(documentName): Uint8Array | null
store(documentName, state, { size, updatedAt })
saveVersion(documentName, { id, label, author, kind, size, createdAt, state })
listVersions(documentName): VersionMeta[]      // la plus récente d'abord, sans state
getVersion(documentName, versionId): StoredVersion | null
```

Le serveur enregistre le document 2 s après la dernière frappe, et au plus
tard toutes les 10 s (`debounce`, `maxDebounce`), puis à la fermeture.

## Client

Rien n'est imposé côté interface : tu fournis l'élément DOM et l'habillage.
Dans un navigateur, importe `@astratra/collab/client` (sans le serveur).

```js
import { createCollabEditor } from '@astratra/collab/client';

const { editor, provider, destroy } = createCollabEditor({
  url: 'wss://collab.exemple.com',
  name: 'wiki/accueil',
  token: () => getAccessToken(),
  element: document.querySelector('#editeur'),
  onAuthenticated: (scope) => afficherBadge(scope === 'readonly' ? 'Lecture seule' : null),
  onDenied: () => afficherErreur('Accès refusé'),
  onLimitExceeded: () => afficherErreur('Document trop volumineux')
});
```

- L'éditeur se met de lui-même en lecture seule quand le serveur n'accorde
  que la lecture.
- `extensions` remplace le kit de départ (`StarterKit` sans historique local :
  avec Yjs, l'annulation passe par le document partagé).
- `createCollabProvider()` donne la connexion seule, sans éditeur (un
  aperçu, un robot, une application mobile qui rend le document autrement).

### Pourquoi pas de composant d'interface

`@astratra/react` ne fournit que de la logique, sans design ; `@astratra/native-ui`
vise React Native, où Tiptap (qui a besoin d'un DOM) ne tourne pas. Il n'y a
donc pas de convention de composant éditeur à suivre : l'application monte
`createCollabEditor` dans son propre composant.

## Conversions (recherche, export, import)

```js
const { createConverter } = require('@astratra/collab');
const conv = createConverter(); // mêmes `extensions` que l'éditeur si tu en ajoutes

const etat = await collab.getDocumentState('wiki/accueil');
conv.toMarkdown(etat);   // export
conv.toHTML(etat);       // affichage hors éditeur ; le texte saisi est échappé
conv.toText(etat);       // à indexer pour la recherche
conv.toJSON(etat);       // JSON Tiptap

const doc = conv.fromMarkdown('# Nouvelle page');   // import → Y.Doc
const etatInitial = conv.encodeState(doc);
await persistence.store('wiki/nouvelle', etatInitial, { size: etatInitial.byteLength, updatedAt: new Date().toISOString() });
```

Les sources acceptées : un `Y.Doc`, un état binaire (`Uint8Array`) ou du JSON
Tiptap. Aucune conversion n'a besoin d'un DOM.

## Tests

`npm test` : deux clients qui écrivent en même temps convergent (Yjs brut et
deux éditeurs Tiptap), lecture seule ignorée par le serveur, refus,
persistance au redémarrage, versions et restauration avec des personnes
connectées, limites de taille, conversions, et le contrat de persistance sur
la mémoire, PostgreSQL (pg-mem) et MongoDB (mongodb-memory-server).

## Licences

Toutes les dépendances sont sous licence MIT (Yjs, y-protocols, y-prosemirror,
Hocuspocus, Tiptap et marked). Aucun code n'est copié : le paquet les utilise
comme dépendances.
