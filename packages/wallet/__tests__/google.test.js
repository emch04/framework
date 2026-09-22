const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createGoogleWallet, signSaveJwt } = require('../src');

const CLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pass-test.key'), 'utf8');
const PUBLIQUE = crypto.createPublicKey(CLE);
const credentials = { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: CLE };

function fauxGoogle(existants = new Set()) {
  const appels = [];
  const request = async (options) => {
    appels.push(options);
    if (options.method === 'PATCH' && !existants.has(options.data.id)) {
      const erreur = new Error('absent'); erreur.response = { status: 404 }; throw erreur;
    }
    existants.add(options.data.id);
    return { data: options.data };
  };
  return { request, appels };
}

test('le lien d’ajout porte un JWT RS256 vérifiable, signé par le compte de service', () => {
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request: async () => ({}) });
  const lien = wallet.saveLink([{ id: '3388.C-1', classId: '3388.fidelite', autre: 'ignoré' }]);
  const jwt = lien.replace('https://pay.google.com/gp/v/save/', '');
  const [entete, corps, signature] = jwt.split('.');
  expect(crypto.createVerify('RSA-SHA256').update(`${entete}.${corps}`).verify(PUBLIQUE, signature, 'base64url')).toBe(true);
  const contenu = JSON.parse(Buffer.from(corps, 'base64url').toString());
  expect(contenu).toMatchObject({ iss: credentials.client_email, aud: 'google', typ: 'savetowallet' });
  expect(contenu.payload).toEqual({ loyaltyObjects: [{ id: '3388.C-1', classId: '3388.fidelite' }] });
});

test('crée la classe au premier appel (404 puis POST), une seule fois par définition', async () => {
  const { request, appels } = fauxGoogle();
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
  const definition = { id: wallet.classId('fidelite'), issuerName: 'Salon', programName: 'Fidélité' };
  await wallet.ensureClass(definition);
  await wallet.ensureClass(definition);
  expect(appels.map((a) => `${a.method} ${a.url.split('/v1/')[1]}`)).toEqual([
    'PATCH loyaltyClass/3388.fidelite', 'POST loyaltyClass'
  ]);
  expect(appels[1].data.reviewStatus).toBe('UNDER_REVIEW');
});

test('met à jour une carte existante sans la recréer', async () => {
  const { request, appels } = fauxGoogle(new Set(['3388.C-1']));
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
  await wallet.upsertObject({ id: wallet.objectId('C-1'), classId: '3388.fidelite', state: 'ACTIVE' });
  expect(appels).toHaveLength(1);
  expect(appels[0].method).toBe('PATCH');
});

test('les identifiants sont nettoyés, les types inconnus refusés', () => {
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request: async () => ({}) });
  expect(wallet.objectId('carte n°1')).toBe('3388.carte_n_1');
  expect(() => createGoogleWallet({ issuerId: '1', credentials, kind: 'avion' })).toThrow(/inconnu/);
  expect(signSaveJwt({}, credentials).split('.')).toHaveLength(3);
});
