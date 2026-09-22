const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createApplePasses, notifyApplePass, createMemoryRegistrationStore } = require('../src');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom));
const CERT = lire('pass-test.pem').toString();
const CLE = lire('pass-test.key').toString();
const PIXEL = lire('pixel.png');

function passes() {
  return createApplePasses({
    certificate: CERT, privateKey: CLE, wwdr: CERT, webServiceURL: 'https://api.test/wallet/apple',
    organizationName: 'Salon Test', description: 'Carte fidélité',
    images: { 'icon.png': PIXEL, 'logo.png': PIXEL }, colors: { backgroundColor: 'rgb(11, 16, 32)' }
  });
}

test('l’identifiant et l’équipe viennent du certificat', () => {
  expect(passes()).toMatchObject({ passTypeIdentifier: 'pass.com.test.fidelite', teamIdentifier: 'TEAM123456' });
});

test('une carte signée est un zip qui contient pass.json, la bande propre à la carte et la signature', () => {
  const buffer = passes().build({
    serialNumber: 'C-000001',
    authenticationToken: 'jeton-assez-long-pour-apple-123',
    secondaryFields: [{ key: 'client', label: 'CLIENT', value: 'Jo' }],
    barcode: { message: 'Carte C-000001', altText: 'C-000001' },
    images: { 'strip.png': PIXEL }
  });
  const contenu = buffer.toString('latin1');
  expect(buffer.subarray(0, 2).toString()).toBe('PK');
  for (const fichier of ['pass.json', 'strip.png', 'signature', 'manifest.json']) expect(contenu).toContain(fichier);
});

test('un certificat qui n’est pas un Pass Type ID est refusé à la construction', () => {
  expect(() => createApplePasses({ certificate: 'x', privateKey: CLE })).toThrow(/illisible/);
});

function faussesConnexions(statuts) {
  const envois = [];
  const connect = () => {
    const session = new EventEmitter();
    session.close = () => {};
    session.request = (headers) => {
      const requete = new EventEmitter();
      requete.end = () => {
        envois.push(headers[':path']);
        setImmediate(() => {
          requete.emit('response', { ':status': statuts.shift() });
          requete.emit('end');
        });
      };
      return requete;
    };
    return session;
  };
  return { connect, envois };
}

test('notifie chaque appareil et oublie les jetons qu’Apple déclare morts', async () => {
  const registrations = createMemoryRegistrationStore();
  const base = { passTypeIdentifier: 'pass.com.test.fidelite', serialNumber: 'C-1' };
  await registrations.register({ ...base, deviceLibraryIdentifier: 'd1', pushToken: 'vivant' });
  await registrations.register({ ...base, deviceLibraryIdentifier: 'd2', pushToken: 'mort' });
  const { connect, envois } = faussesConnexions([200, 410]);

  await expect(notifyApplePass({ registrations, ...base, certificate: CERT, privateKey: CLE, connect })).resolves.toBe(2);
  expect(envois).toEqual(['/3/device/vivant', '/3/device/mort']);
  expect((await registrations.listForPass(base.passTypeIdentifier, 'C-1')).map((r) => r.pushToken)).toEqual(['vivant']);
});

test('une panne APNs autre que « jeton mort » remonte', async () => {
  const registrations = createMemoryRegistrationStore();
  await registrations.register({ passTypeIdentifier: 'p', serialNumber: 's', deviceLibraryIdentifier: 'd', pushToken: 't' });
  const { connect } = faussesConnexions([500]);
  await expect(notifyApplePass({ registrations, passTypeIdentifier: 'p', serialNumber: 's', certificate: CERT, privateKey: CLE, connect }))
    .rejects.toMatchObject({ status: 500 });
});
