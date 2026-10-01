const Y = require('yjs');
const { createCollabServer, createMemoryPersistence } = require('../src');
const { demarrerServeur, attendre, pause, client } = require('../test/helpers');

/* Hocuspocus écrit sur la sortie d'erreur chaque connexion qu'il ferme pour
   une limite dépassée : attendu ici, donc rendu muet. */
beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterAll(() => console.error.mockRestore());

const ouverts = [];
async function serveur(options) {
  const resultat = await demarrerServeur(options);
  ouverts.push(resultat.collab);
  return resultat;
}
const clients = [];
async function connecter(...args) {
  const c = await client(...args);
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  for (const s of ouverts.splice(0)) await s.destroy();
});

const etatServeur = async (collab, nom) => {
  const doc = new Y.Doc();
  const etat = await collab.getDocumentState(nom);
  if (etat) Y.applyUpdate(doc, etat);
  return doc.getText('t').toString();
};

describe('deux personnes éditent en même temps', () => {
  test('leurs modifications simultanées convergent vers le même texte, serveur compris', async () => {
    const { collab, url } = await serveur();
    const a = await connecter(url, 'wiki/accueil', 'jeton-ecriture');
    const b = await connecter(url, 'wiki/accueil', 'jeton-ecriture-2');

    // Les deux écrivent au même endroit avant d'avoir vu l'autre.
    a.document.getText('t').insert(0, 'Alice ');
    b.document.getText('t').insert(0, 'Bob ');
    a.document.getText('t').insert(a.texte().length, 'fin-A');
    b.document.getText('t').insert(b.texte().length, 'fin-B');

    await attendre(() => a.texte() === b.texte() && a.texte().length === 'Alice Bob fin-Afin-B'.length);
    for (const morceau of ['Alice ', 'Bob ', 'fin-A', 'fin-B']) expect(a.texte()).toContain(morceau);
    await attendre(async () => (await etatServeur(collab, 'wiki/accueil')) === a.texte());
  });
});

describe('droits par document', () => {
  test('lecture seule : la modification locale ne part nulle part', async () => {
    const { collab, url } = await serveur();
    const ecrivain = await connecter(url, 'doc', 'jeton-ecriture');
    const lecteur = await connecter(url, 'doc', 'jeton-lecture');
    expect(ecrivain.etat.scope).toBe('read-write');
    expect(lecteur.etat.scope).toBe('readonly');

    lecteur.document.getText('t').insert(0, 'INTRUS');
    // L'écrivain écrit ensuite : quand le lecteur reçoit ce texte, le serveur
    // a forcément déjà traité (et ignoré) la modification du lecteur.
    ecrivain.document.getText('t').insert(0, 'officiel');
    await attendre(() => lecteur.texte().includes('officiel'));

    expect(ecrivain.texte()).toBe('officiel');
    expect(await etatServeur(collab, 'doc')).toBe('officiel');
  });

  test('aucun droit : la connexion est refusée et rien n’est synchronisé', async () => {
    const { url } = await serveur();
    const inconnu = await connecter(url, 'doc', 'jeton-inconnu');
    expect(inconnu.etat.refus).toBe('permission-denied');
    expect(inconnu.provider.isSynced).toBe(false);
  });

  test('le crochet reçoit le jeton et le nom du document ; une exception vaut refus', async () => {
    const appels = [];
    const { url } = await serveur({
      authenticate: async ({ token, documentName }) => {
        appels.push({ token, documentName });
        if (documentName === 'secret') throw new Error('base indisponible');
        return { access: 'write', user: { id: 'u1' } };
      }
    });
    const ok = await connecter(url, 'public', 'abc');
    const refuse = await connecter(url, 'secret', 'abc');
    expect(ok.etat.scope).toBe('read-write');
    expect(refuse.etat.refus).toBe('permission-denied');
    expect(appels).toEqual([{ token: 'abc', documentName: 'public' }, { token: 'abc', documentName: 'secret' }]);
  });
});

describe('persistance', () => {
  test('un document survit au redémarrage du serveur', async () => {
    const persistence = createMemoryPersistence();
    const premier = await serveur({ persistence });
    const a = await connecter(premier.url, 'note', 'jeton-ecriture');
    a.document.getText('t').insert(0, 'à garder');
    await attendre(async () => (await etatServeur(premier.collab, 'note')) === 'à garder');
    a.provider.destroy();
    await premier.collab.destroy();
    ouverts.splice(ouverts.indexOf(premier.collab), 1);

    expect(await persistence.load('note')).toBeInstanceOf(Uint8Array);
    const second = await serveur({ persistence });
    const b = await connecter(second.url, 'note', 'jeton-ecriture');
    await attendre(() => b.texte() === 'à garder');
  });
});

describe('limites de taille', () => {
  test('un message trop gros coupe la connexion et n’est pas appliqué', async () => {
    const { collab, url } = await serveur({ limits: { maxMessageBytes: 1000 } });
    const temoin = await connecter(url, 'doc', 'jeton-ecriture-2');
    const gros = await connecter(url, 'doc', 'jeton-ecriture');

    gros.document.getText('t').insert(0, 'x'.repeat(5000));
    await attendre(() => gros.etat.limite);
    temoin.document.getText('t').insert(0, 'petit');
    await attendre(async () => (await etatServeur(collab, 'doc')) === 'petit');
    await pause(100);

    // Coupé par le serveur WebSocket avant même le décodage ; pas de reconnexion en boucle.
    expect(gros.etat.limite).toBeTruthy();
    expect(gros.provider.configuration.websocketProvider.shouldConnect).toBe(false);
    expect(temoin.texte()).toBe('petit');
    expect(await etatServeur(collab, 'doc')).toBe('petit');
  });

  test('un document qui dépasserait sa taille maximale refuse la modification', async () => {
    const { collab, url } = await serveur({ limits: { maxDocumentBytes: 3000, maxMessageBytes: 10000 } });
    const a = await connecter(url, 'doc', 'jeton-ecriture');

    a.document.getText('t').insert(0, 'a'.repeat(2000));
    await attendre(async () => (await etatServeur(collab, 'doc')).length === 2000);
    a.document.getText('t').insert(0, 'b'.repeat(2000));
    await attendre(() => a.etat.limite);

    expect(a.etat.limite).toBe('document-too-large');
    expect(await etatServeur(collab, 'doc')).toBe('a'.repeat(2000));
  });
});

describe('configuration', () => {
  test('refuse une persistance incomplète et un crochet manquant', () => {
    expect(() => createCollabServer({})).toThrow(/authenticate/);
    expect(() => createCollabServer({ authenticate: () => 'write', persistence: { load() {} } })).toThrow(/store/);
  });
});
