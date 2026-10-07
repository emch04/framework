import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lireRetryAfter, transportFetch } from '../src/transport.ts';

test('transportFetch : POST, en-têtes, statut et Retry-After ; délai dépassé => rejet', async () => {
  const recus: Array<{ methode?: string; cle?: string; type?: string; corps: string }> = [];
  const serveur = createServer((req, res) => {
    let corps = '';
    req.on('data', (m) => { corps += m; });
    req.on('end', () => {
      recus.push({ methode: req.method, cle: req.headers['x-centrale-cle'] as string, type: req.headers['content-type'], corps });
      if (req.url === '/lent') return; // ne répond jamais
      res.writeHead(429, { 'Retry-After': '12' }).end('trop');
    });
  });
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  try {
    const reponse = await transportFetch()({ url: `${base}/v1/envoi`, entetes: { 'Content-Type': 'application/json', 'X-Centrale-Cle': 'clj_pub_x' }, corps: '{"a":1}' });
    assert.deepEqual(reponse, { statut: 429, reessayerApres: '12' });
    assert.deepEqual(recus[0], { methode: 'POST', cle: 'clj_pub_x', type: 'application/json', corps: '{"a":1}' });
    await assert.rejects(transportFetch(50)({ url: `${base}/lent`, entetes: {}, corps: '{}' }));
  } finally {
    serveur.closeAllConnections();
    serveur.close();
  }
});

test('lireRetryAfter : secondes, date HTTP, absente ou illisible', () => {
  const t = Date.UTC(2026, 9, 7, 12, 0, 0);
  assert.equal(lireRetryAfter('30', t), 30_000);
  assert.equal(lireRetryAfter('1.5', t), 1500);
  assert.equal(lireRetryAfter(new Date(t + 90_000).toUTCString(), t), 90_000);
  assert.equal(lireRetryAfter(new Date(t - 90_000).toUTCString(), t), 0);
  assert.equal(lireRetryAfter(null, t), null);
  assert.equal(lireRetryAfter('bientôt', t), null);
});
