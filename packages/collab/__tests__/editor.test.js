// Le DOM doit exister avant que Tiptap ne soit chargé.
require('../test/dom');
const { createCollabEditor, createConverter } = require('../src');
const { demarrerServeur, attendre } = require('../test/helpers');

const conv = createConverter();
let collab;
let url;
const ouverts = [];

beforeEach(async () => {
  ({ collab, url } = await demarrerServeur());
});
afterEach(async () => {
  for (const e of ouverts.splice(0)) e.destroy();
  await collab.destroy();
});

async function editeur(token, options = {}) {
  const element = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(element);
  const etat = { scope: null, refus: null };
  const e = createCollabEditor({
    url,
    name: 'wiki/page',
    token,
    element,
    onAuthenticated: (scope) => { etat.scope = scope; },
    onDenied: (raison) => { etat.refus = raison; },
    ...options
  });
  e.etat = etat;
  ouverts.push(e);
  await attendre(() => e.provider.isSynced || etat.refus);
  return e;
}

test('deux éditeurs Tiptap qui écrivent en même temps convergent, et le serveur exporte le même Markdown', async () => {
  const alice = await editeur('jeton-ecriture');
  const bob = await editeur('jeton-ecriture-2');

  alice.editor.commands.setContent('<h1>Accueil</h1><p>Texte commun</p>');
  await attendre(() => bob.editor.getText().includes('Texte commun'));

  // Écritures simultanées : Alice en fin de paragraphe, Bob au début.
  alice.editor.chain().setTextSelection(alice.editor.state.doc.content.size - 1).insertContent(' — ajout Alice').run();
  bob.editor.chain().setTextSelection(2).insertContent('Bob : ').run();

  await attendre(() => alice.editor.getHTML() === bob.editor.getHTML() && alice.editor.getText().includes('Bob : ') && alice.editor.getText().includes('ajout Alice'));
  expect(alice.editor.getJSON()).toEqual(bob.editor.getJSON());

  const attendu = conv.toMarkdown(alice.editor.getJSON());
  expect(attendu).toContain('# ');
  expect(attendu).toContain('ajout Alice');
  await attendre(async () => conv.toMarkdown(await collab.getDocumentState('wiki/page')) === attendu);
});

test('lecture seule : l’éditeur se verrouille et ses modifications forcées ne sortent pas', async () => {
  const ecrivain = await editeur('jeton-ecriture');
  const lecteur = await editeur('jeton-lecture');
  await attendre(() => lecteur.etat.scope === 'readonly');
  expect(lecteur.editor.isEditable).toBe(false);
  expect(ecrivain.editor.isEditable).toBe(true);

  // Même en contournant le verrou de l'éditeur, le serveur ignore l'écriture.
  lecteur.editor.commands.setContent('<p>INTRUS</p>');
  ecrivain.editor.commands.setContent('<p>officiel</p>');
  await attendre(() => lecteur.editor.getText().includes('officiel'));
  expect(ecrivain.editor.getText()).not.toContain('INTRUS');
  expect(conv.toText(await collab.getDocumentState('wiki/page'))).toBe('officiel');
});

test('sans droit : refus signalé, l’éditeur reste vide', async () => {
  const intrus = await editeur('jeton-inconnu');
  expect(intrus.etat.refus).toBe('permission-denied');
  expect(intrus.editor.getText()).toBe('');
});

test('destroy ferme l’éditeur et le fournisseur qu’il a créé', async () => {
  const e = await editeur('jeton-ecriture');
  ouverts.splice(ouverts.indexOf(e), 1);
  e.destroy();
  expect(e.editor.isDestroyed).toBe(true);
  await attendre(() => collab.hocuspocus.getConnectionsCount() === 0);
});
