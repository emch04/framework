/**
 * Retirer une carte déjà ajoutée (extraction Barber Clean, 23/09/2026).
 * L'émetteur ne peut pas effacer une carte du téléphone de quelqu'un : il
 * peut la griser chez Apple (`voided`), la passer inactive chez Google, et
 * oublier les appareils qui la portaient.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApplePasses, createGoogleWallet, createMemoryRegistrationStore } = require('../src');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom));
const CERT = lire('pass-test.pem').toString();
const CLE = lire('pass-test.key').toString();
const PIXEL = lire('pixel.png');
const credentials = { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: CLE };

function construire(carte) {
  return createApplePasses({
    certificate: CERT, privateKey: CLE, wwdr: CERT, webServiceURL: 'https://api.test/wallet/apple',
    organizationName: 'Salon Test', description: 'Carte', images: { 'icon.png': PIXEL }
  }).build({ serialNumber: 'C-000001', authenticationToken: 'jeton-assez-long-pour-apple-123', ...carte }).toString('latin1');
}

test('Apple : une carte annulée porte voided, une carte normale non', () => {
  expect(construire({ voided: true })).toContain('"voided":true');
  expect(construire({})).not.toContain('"voided"');
  expect(construire({ voided: false })).not.toContain('"voided"');
});

test('oublier une carte désinscrit tous ses appareils, et seulement elle', async () => {
  const registre = createMemoryRegistrationStore();
  const inscrire = (device, passType, serial) => registre.register({
    deviceLibraryIdentifier: device, passTypeIdentifier: passType, serialNumber: serial, pushToken: `t-${device}-${serial}`
  });
  await inscrire('d1', 'pass.a', 'C-1');
  await inscrire('d2', 'pass.a', 'C-1');
  await inscrire('d1', 'pass.a', 'C-2');
  await inscrire('d3', 'pass.b', 'C-1');

  expect(await registre.forgetPass('pass.a', 'C-1')).toBe(2);
  expect(await registre.listForPass('pass.a', 'C-1')).toEqual([]);
  expect(await registre.listForPass('pass.a', 'C-2')).toHaveLength(1);
  expect(await registre.listForPass('pass.b', 'C-1')).toHaveLength(1);
  expect(await registre.forgetPass('pass.a', 'C-1')).toBe(0);
});

function fauxGoogle(reponse) {
  const appels = [];
  const request = async (options) => {
    appels.push(options);
    return reponse(options);
  };
  return { appels, wallet: createGoogleWallet({ issuerId: '3388', credentials, kind: 'generic', request }) };
}

test('Google : retirer une carte n’envoie que son état, sans rien recréer', async () => {
  const { appels, wallet } = fauxGoogle(() => ({ data: {} }));
  expect(await wallet.deactivateObject(wallet.objectId('A-000007'))).toBe(true);
  expect(appels).toHaveLength(1);
  expect(appels[0]).toMatchObject({ method: 'PATCH', data: { state: 'INACTIVE' } });
  expect(appels[0].url).toMatch(/genericObject\/3388\.A-000007$/);
  await wallet.deactivateObject(wallet.objectId('A-000007'), 'EXPIRED');
  expect(appels[1].data).toEqual({ state: 'EXPIRED' });
});

test('Google : une carte que personne n’a ajoutée n’est pas créée pour être retirée', async () => {
  const { appels, wallet } = fauxGoogle(() => {
    const erreur = new Error('absent'); erreur.response = { status: 404 }; throw erreur;
  });
  expect(await wallet.deactivateObject('3388.A-000008')).toBe(false);
  expect(appels.map((appel) => appel.method)).toEqual(['PATCH']);
});

test('Google : une vraie panne remonte, un état inconnu est refusé', async () => {
  const { wallet } = fauxGoogle(() => {
    const erreur = new Error('quota'); erreur.response = { status: 429 }; throw erreur;
  });
  await expect(wallet.deactivateObject('3388.A-000009')).rejects.toThrow('quota');
  await expect(wallet.deactivateObject('3388.A-000009', 'ACTIVE')).rejects.toThrow(/inconnu/);
});
