import * as Y from 'yjs';
import {
  createCollabServer,
  createCollabEditor,
  createCollabProvider,
  createConverter,
  createMemoryPersistence,
  createPostgresPersistence,
  createMongoPersistence,
  defaultExtensions,
  DEFAULT_FIELD
} from './src';
import type { AuthenticateDecision, CollabPersistence, CollabServer, Converter, VersionMeta } from './src';
import { createCollabEditor as editeurNavigateur } from './src/client-entry';

const persistence: CollabPersistence = createMemoryPersistence();
const pg: CollabPersistence = createPostgresPersistence({ pool: { query: async () => ({ rows: [] }) }, versionsTable: 'wiki_versions' });
const mongo: CollabPersistence = createMongoPersistence({ db: { collection: () => ({}) } });

const serveur: CollabServer = createCollabServer({
  authenticate: async ({ token, documentName }): Promise<AuthenticateDecision> =>
    token === 'ok' ? { access: documentName.startsWith('public/') ? 'read' : 'write', user: { id: 'u1' } } : 'none',
  persistence,
  limits: { maxDocumentBytes: 2_000_000, maxMessageBytes: 500_000 },
  fields: [DEFAULT_FIELD]
});

async function versions(): Promise<VersionMeta[]> {
  await serveur.listen(1234);
  const v = await serveur.createVersion('wiki/accueil', { label: 'Validée', author: 'u1' });
  const { backup } = await serveur.restoreVersion('wiki/accueil', v.id, { author: 'u2' });
  const etat: Uint8Array | null = await serveur.getDocumentState('wiki/accueil');
  void etat;
  void backup;
  return serveur.listVersions('wiki/accueil');
}

const conv: Converter = createConverter({ extensions: defaultExtensions() });
const doc: Y.Doc = conv.fromMarkdown('# Titre');
const markdown: string = conv.toMarkdown(doc);
const html: string = conv.toHTML(conv.encodeState(doc));
const texte: string = conv.toText(conv.toJSON(doc));

const provider = createCollabProvider({ url: 'wss://collab.example', name: 'wiki/accueil', token: () => 'jeton', onLimitExceeded: (raison) => void raison });
const { editor, destroy } = createCollabEditor({ provider, element: null, onDenied: (raison) => void raison });
const autre = editeurNavigateur({ url: 'wss://collab.example', name: 'wiki/accueil', token: 'jeton' });
editor.commands.setContent('<p>Bonjour</p>');

export { pg, mongo, versions, markdown, html, texte, destroy, autre };
