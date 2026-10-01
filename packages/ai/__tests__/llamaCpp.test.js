'use strict';

const { createLlamaCppProvider, createLlamaCppConfig, normalizeLlamaCppUrl, LocalLlmError } = require('../src');
const { startFakeServer, sendJson } = require('./llamaCppServer');

let server;
afterEach(async () => { if (server) await server.close(); server = null; });

describe('configuration', () => {
  test('normalise la base : /v1 et barres finales retirés', () => {
    expect(normalizeLlamaCppUrl('http://h:8080/v1/')).toBe('http://h:8080');
    expect(normalizeLlamaCppUrl('https://h')).toBe('https://h');
    expect(createLlamaCppConfig().baseUrl).toBe('http://127.0.0.1:8080');
  });
  test('refuse une base ou un délai invalide', () => {
    expect(() => normalizeLlamaCppUrl('ftp://h')).toThrow('INVALID_BASE_URL');
    expect(() => normalizeLlamaCppUrl('pas une url')).toThrow('INVALID_BASE_URL');
    expect(() => createLlamaCppConfig({ timeoutMs: 0 })).toThrow('INVALID_TIMEOUT');
  });
  test('toOpenAICompatible donne baseURL /v1', () => {
    const p = createLlamaCppProvider({ baseUrl: 'http://h:8080', apiKey: 'k', model: 'm' });
    expect(p.toOpenAICompatible()).toEqual({ baseURL: 'http://h:8080/v1', apiKey: 'k', model: 'm' });
  });
});

describe('santé', () => {
  test('ok', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 200, { status: 'ok' }));
    const state = await createLlamaCppProvider({ baseUrl: server.url }).health();
    expect(state).toMatchObject({ ok: true, status: 'ok' });
    expect(server.requests[0].url).toBe('/health');
  });
  test('chargement du modèle (503), clé refusée (401), erreur (500)', async () => {
    let status = 503;
    server = await startFakeServer((req, res) => sendJson(res, status, { error: { message: 'Loading model' } }));
    const p = createLlamaCppProvider({ baseUrl: server.url });
    expect(await p.health()).toMatchObject({ ok: false, status: 'loading', httpStatus: 503 });
    status = 401;
    expect((await p.health()).status).toBe('unauthorized');
    status = 500;
    expect((await p.health()).status).toBe('error');
  });
  test('serveur éteint : unreachable, sans lancer', async () => {
    const p = createLlamaCppProvider({ baseUrl: 'http://127.0.0.1:1' });
    expect(await p.health()).toMatchObject({ ok: false, status: 'unreachable' });
  });
  test('délai dépassé : timeout', async () => {
    server = await startFakeServer(() => { /* ne répond jamais */ });
    const p = createLlamaCppProvider({ baseUrl: server.url, healthTimeoutMs: 100 });
    expect((await p.health()).status).toBe('timeout');
  });
  test('waitUntilReady attend la fin du chargement', async () => {
    let calls = 0;
    server = await startFakeServer((req, res) => (++calls < 3 ? sendJson(res, 503, { error: { message: 'Loading model' } }) : sendJson(res, 200, { status: 'ok' })));
    const p = createLlamaCppProvider({ baseUrl: server.url, sleep: async () => {} });
    await expect(p.waitUntilReady({ timeoutMs: 60_000, intervalMs: 1 })).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });
  test('waitUntilReady abandonne après le délai, et tout de suite si la clé est refusée', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 503, { error: { message: 'Loading model' } }));
    const p = createLlamaCppProvider({ baseUrl: server.url, sleep: async () => {} });
    await expect(p.waitUntilReady({ timeoutMs: 5, intervalMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await server.close();
    server = await startFakeServer((req, res) => sendJson(res, 401, {}));
    const q = createLlamaCppProvider({ baseUrl: server.url, sleep: async () => {} });
    await expect(q.waitUntilReady()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('modèles et discussion', () => {
  test('listModels transmet la clé et convertit le format', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 200, { object: 'list', data: [{ id: 'local', object: 'model', owned_by: 'llamacpp' }] }));
    const models = await createLlamaCppProvider({ baseUrl: server.url, apiKey: 'secret' }).listModels();
    expect(models).toEqual([{ id: 'local', ownedBy: 'llamacpp' }]);
    expect(server.requests[0].headers.authorization).toBe('Bearer secret');
  });
  test('listModels : réponse invalide', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 200, { nope: 1 }));
    await expect(createLlamaCppProvider({ baseUrl: server.url }).listModels()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  test('chat envoie le modèle configuré et rend texte, usage, fin', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 200, {
      model: 'local', choices: [{ message: { role: 'assistant', content: 'Bonjour !' }, finish_reason: 'stop' }], usage: { total_tokens: 12 }
    }));
    const p = createLlamaCppProvider({ baseUrl: server.url, model: 'local' });
    const result = await p.chat([{ role: 'user', content: 'Salut' }], { temperature: 0.1 });
    expect(result).toEqual({ text: 'Bonjour !', finishReason: 'stop', usage: { total_tokens: 12 }, model: 'local' });
    expect(server.requests[0].body).toMatchObject({ model: 'local', stream: false, temperature: 0.1 });
    expect(server.requests[0].url).toBe('/v1/chat/completions');
  });
  test('chat : messages obligatoires, erreurs HTTP typées', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 400, { error: { message: 'context too long' } }));
    const p = createLlamaCppProvider({ baseUrl: server.url });
    await expect(p.chat([])).rejects.toThrow('MESSAGES_REQUIRED');
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 400, message: 'context too long' });
  });
  test('chat : 503 de chargement et délai', async () => {
    server = await startFakeServer((req, res) => sendJson(res, 503, { error: { message: 'Loading model' } }));
    await expect(createLlamaCppProvider({ baseUrl: server.url }).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'LOADING' });
    await server.close();
    server = await startFakeServer(() => {});
    const slow = createLlamaCppProvider({ baseUrl: server.url, timeoutMs: 100 });
    await expect(slow.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LocalLlmError);
    await expect(slow.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  test('chatStream assemble les fragments SSE, même coupés en plein milieu', async () => {
    server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
      const all = `${frame('Bon')}${frame('jour')}data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\ndata: [DONE]\n\n`;
      res.write(all.slice(0, 20));
      setTimeout(() => { res.write(all.slice(20)); res.end(); }, 20);
    });
    const p = createLlamaCppProvider({ baseUrl: server.url });
    let text = '';
    for await (const piece of p.chatStream([{ role: 'user', content: 'x' }])) text += piece;
    expect(text).toBe('Bonjour');
    expect(server.requests[0].body.stream).toBe(true);
  });
});
