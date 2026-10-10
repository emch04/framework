const http = require('node:http');
const { createKeepAliveFetch, isStaleConnection } = require('../src');

function server() {
  let connections = 0;
  const s = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
  s.keepAliveTimeout = 60_000;
  s.on('connection', () => { connections += 1; });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/`, count: () => connections })));
}

test('deux demandes espacées de 5 s passent par la même connexion (Node l’aurait refermée après 4 s)', async () => {
  const { s, url, count } = await server();
  const f = createKeepAliveFetch({ keepAliveMs: 30_000 });
  try {
    expect(await (await f(url, { method: 'POST', body: 'a' })).text()).toBe('ok');
    await new Promise((r) => setTimeout(r, 5000));
    expect(await (await f(url, { method: 'POST', body: 'b' })).text()).toBe('ok');
    expect(count()).toBe(1);
  } finally {
    await f.close();
    s.close();
  }
}, 15_000);

test('une connexion fermée par l’autre côté : la demande est refaite une fois', async () => {
  const stale = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
  const calls = [];
  const fakeUndici = { Agent: class { close() { return Promise.resolve(); } }, fetch: async (url, init) => { calls.push(init); if (calls.length === 1) throw stale; return { ok: true }; } };
  const f = createKeepAliveFetch({ undici: fakeUndici });
  expect(await f('https://api.test/', { method: 'POST', body: '{}' })).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  expect(calls[1].dispatcher).toBe(calls[0].dispatcher);
});

test('jamais refaite : une autre erreur, une demande annulée, un corps en flux', async () => {
  const stale = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  let calls = 0;
  const fakeUndici = { Agent: class { close() {} }, fetch: async () => { calls += 1; throw stale; } };
  const f = createKeepAliveFetch({ undici: fakeUndici });
  const aborted = globalThis.AbortSignal.abort();
  await expect(f('https://api.test/', { signal: aborted })).rejects.toBe(stale);
  await expect(f('https://api.test/', { method: 'POST', body: new globalThis.ReadableStream() })).rejects.toBe(stale);
  expect(calls).toBe(2);
  const other = createKeepAliveFetch({ undici: { Agent: class { close() {} }, fetch: async () => { throw new Error('refusé'); } } });
  await expect(other('https://api.test/')).rejects.toThrow('refusé');
  expect(isStaleConnection(new Error('x'))).toBe(false);
});

test('keepAliveMs trop court est refusé', () => {
  expect(() => createKeepAliveFetch({ keepAliveMs: 10, undici: { Agent: class {}, fetch: async () => ({}) } })).toThrow(TypeError);
});
