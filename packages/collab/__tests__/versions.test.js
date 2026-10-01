const Y = require('yjs');
const { createConverter, createMemoryPersistence } = require('../src');
const { demarrerServeur, attendre, client } = require('../test/helpers');

const conv = createConverter();
let collab;
let url;
let persistence;
const clients = [];

beforeEach(async () => {
  persistence = createMemoryPersistence();
  ({ collab, url } = await demarrerServeur({ persistence }));
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  await collab.destroy();
});

/** Remplace le contenu du document d'un client par un Markdown. */
function ecrire(document, markdown) {
  const source = conv.fromMarkdown(markdown);
  const fragment = document.getXmlFragment('default');
  document.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.insert(0, source.getXmlFragment('default').toArray().map((n) => n.clone()));
  });
}
const markdownServeur = async (nom) => conv.toMarkdown(await collab.getDocumentState(nom));

test('instantané nommé, modification, restauration : tout le monde revient à la version', async () => {
  const a = await client(url, 'wiki/procedure', 'jeton-ecriture');
  const b = await client(url, 'wiki/procedure', 'jeton-ecriture-2');
  clients.push(a, b);

  ecrire(a.document, '# Procédure\n\nVersion validée.');
  await attendre(async () => (await markdownServeur('wiki/procedure')) === '# Procédure\n\nVersion validée.');
  const v1 = await collab.createVersion('wiki/procedure', { label: 'Validée', author: 'u-ecrivain' });
  expect(v1).toMatchObject({ documentName: 'wiki/procedure', label: 'Validée', author: 'u-ecrivain', kind: 'manual' });
  expect(v1.size).toBeGreaterThan(0);

  ecrire(b.document, '# Procédure\n\nBrouillon cassé.');
  await attendre(() => conv.toMarkdown(a.document) === '# Procédure\n\nBrouillon cassé.');

  const { restoredFrom, backup } = await collab.restoreVersion('wiki/procedure', v1.id, { author: 'u-admin' });
  expect(restoredFrom.id).toBe(v1.id);
  expect(backup).toMatchObject({ kind: 'backup', author: 'u-admin', label: 'Avant restauration : Validée' });

  // Les deux personnes, toujours connectées, reçoivent la restauration.
  await attendre(() => conv.toMarkdown(a.document) === '# Procédure\n\nVersion validée.');
  await attendre(() => conv.toMarkdown(b.document) === '# Procédure\n\nVersion validée.');
  expect(await markdownServeur('wiki/procedure')).toBe('# Procédure\n\nVersion validée.');

  // Et la restauration s'annule : la sauvegarde contient le brouillon.
  const sauvegarde = await persistence.getVersion('wiki/procedure', backup.id);
  expect(conv.toMarkdown(sauvegarde.state)).toBe('# Procédure\n\nBrouillon cassé.');
  expect((await collab.listVersions('wiki/procedure')).map((v) => v.kind)).toEqual(['backup', 'manual']);
});

test('restauration sans personne connectée : le document stocké est remis en état', async () => {
  const a = await client(url, 'note', 'jeton-ecriture');
  ecrire(a.document, 'Premier jet');
  await attendre(async () => (await markdownServeur('note')) === 'Premier jet');
  const v1 = await collab.createVersion('note', { label: 'v1' });
  ecrire(a.document, 'Second jet');
  await attendre(async () => (await markdownServeur('note')) === 'Second jet');
  a.provider.destroy();
  await attendre(() => !collab.hocuspocus.documents.has('note'));

  await collab.restoreVersion('note', v1.id);
  expect(collab.hocuspocus.documents.has('note')).toBe(false);
  const stocke = new Y.Doc();
  Y.applyUpdate(stocke, await persistence.load('note'));
  expect(conv.toMarkdown(stocke)).toBe('Premier jet');
});

test('version ou document inconnus : erreurs nommées, rien n’est créé', async () => {
  await expect(collab.createVersion('fantome')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  expect(await persistence.load('fantome')).toBeNull();

  const a = await client(url, 'reel', 'jeton-ecriture');
  clients.push(a);
  await expect(collab.restoreVersion('reel', 'pas-une-version')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
});
