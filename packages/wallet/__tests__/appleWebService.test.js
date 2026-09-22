const express = require('express');
const request = require('supertest');
const { createAppleWebServiceRouter, createMemoryRegistrationStore } = require('../src');

const PASS_TYPE = 'pass.com.test.fidelite';
const JETON = 'jeton-de-la-carte-123456';

function app({ configure = true, updatedAt = '2026-09-22T10:00:00Z' } = {}) {
  const registrations = createMemoryRegistrationStore();
  const logs = [];
  const serveur = express();
  serveur.use(express.json());
  serveur.use('/wallet/apple', createAppleWebServiceRouter({
    resolveConfig: async () => (configure ? { passTypeIdentifier: PASS_TYPE } : null),
    findPass: async (serial) => (serial === 'C-1' ? { authenticationToken: JETON, updatedAt } : null),
    buildPass: async () => Buffer.from('pkpass'),
    registrations,
    logger: { warn: (message) => logs.push(message) }
  }));
  return { serveur, registrations, logs };
}

const inscription = `/wallet/apple/v1/devices/d1/registrations/${PASS_TYPE}/C-1`;

test('inscrit un appareil authentifié : 201 puis 200', async () => {
  const { serveur } = app();
  const auth = { Authorization: `ApplePass ${JETON}` };
  expect((await request(serveur).post(inscription).set(auth).send({ pushToken: 't1' })).status).toBe(201);
  expect((await request(serveur).post(inscription).set(auth).send({ pushToken: 't2' })).status).toBe(200);
});

test('refuse sans le bon jeton, une carte inconnue ou un autre type de carte', async () => {
  const { serveur } = app();
  expect((await request(serveur).post(inscription).set({ Authorization: 'ApplePass faux' }).send({ pushToken: 't' })).status).toBe(401);
  expect((await request(serveur).post(inscription.replace('C-1', 'C-9')).set({ Authorization: `ApplePass ${JETON}` }).send({ pushToken: 't' })).status).toBe(404);
  expect((await request(serveur).post(inscription.replace(PASS_TYPE, 'pass.autre')).send({ pushToken: 't' })).status).toBe(404);
});

test('liste les cartes changées depuis une date, 204 sinon', async () => {
  const { serveur } = app();
  await request(serveur).post(inscription).set({ Authorization: `ApplePass ${JETON}` }).send({ pushToken: 't' });
  const liste = `/wallet/apple/v1/devices/d1/registrations/${PASS_TYPE}`;
  const avant = await request(serveur).get(liste).query({ passesUpdatedSince: '2026-01-01T00:00:00Z' });
  expect(avant.body).toEqual({ serialNumbers: ['C-1'], lastUpdated: '2026-09-22T10:00:00.000Z' });
  expect((await request(serveur).get(liste).query({ passesUpdatedSince: '2026-12-01T00:00:00Z' })).status).toBe(204);
});

test('renvoie la dernière version signée, puis désinscrit', async () => {
  const { serveur, registrations } = app();
  const auth = { Authorization: `ApplePass ${JETON}` };
  const carte = await request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`).set(auth);
  expect(carte.status).toBe(200);
  expect(carte.headers['content-type']).toMatch(/application\/vnd.apple.pkpass/);
  await request(serveur).post(inscription).set(auth).send({ pushToken: 't' });
  expect((await request(serveur).delete(inscription).set(auth)).status).toBe(200);
  expect(await registrations.listForPass(PASS_TYPE, 'C-1')).toEqual([]);
});

test('503 tant qu’Apple Wallet n’est pas configuré ; les journaux sont relayés', async () => {
  const { serveur, logs } = app({ configure: false });
  expect((await request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`)).status).toBe(503);
  await request(serveur).post('/wallet/apple/v1/log').send({ logs: ['erreur appareil'] });
  expect(logs).toEqual(['Apple Wallet: erreur appareil']);
});
