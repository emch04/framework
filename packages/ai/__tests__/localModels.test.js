const { createLocalModelsClient, LOCAL_VECTOR_MODEL, LOCAL_VECTOR_DIMENSIONS, validPcmAudio, createTokenFileReader, AiServiceError, serviceRequest } = require('../src');
const { httpFixture, json } = require('./httpFixture');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
let fixture;
let handle;
let directory;
const vector = () => Array(LOCAL_VECTOR_DIMENSIONS).fill(0.25);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai-models-test-'));
  handle = ({ req, res, body }) => {
    const responses = {
      '/reclasser': { scores: body.passages?.map((_, at) => at / 10) },
      '/nli': { resultats: body.paires?.map(() => ({ accord: 0.1, neutre: 0.1, contradiction: 0.8 })) },
      '/entites': { entites: [{ texte: 'Ada', type: 'person', debut: 3, fin: 6, score: 0.95 }] },
      '/vecteurs': { vecteurs: body.textes?.map(vector), modele: LOCAL_VECTOR_MODEL, dimensions: LOCAL_VECTOR_DIMENSIONS },
      '/transcrire': { texte: 'hello world', langue: 'en', logprob: -0.1, sans_parole: 0.01, duree_ms: 300 }
    };
    json(res, responses[req.url]);
  };
  fixture = await httpFixture((args) => handle(args));
});
afterEach(async () => { await fixture?.close(); await rm(directory, { recursive: true }); });
const client = (options = {}) => createLocalModelsClient({ baseUrl: fixture.url, ...options });
const pcm = () => Buffer.alloc(6400).toString('base64');

test('all five local routes follow the exact local model wire contract and vector space', async () => {
  const local = client();
  expect(await local.reclasser('question', ['one', 'two'])).toEqual([0, 0.1]);
  expect(await local.nli([{ premisse: 'a', hypothese: 'b' }])).toEqual([{ accord: 0.1, neutre: 0.1, contradiction: 0.8 }]);
  expect(await local.entites('😀 Ada', ['person'])).toEqual([{ texte: 'Ada', type: 'person', debut: 3, fin: 6, score: 0.95 }]);
  const vectors = await local.vecteurs(['a', 'b']);
  expect(vectors).toHaveLength(2); expect(vectors.modele).toBe(LOCAL_VECTOR_MODEL); expect(vectors.dimensions).toBe(1024);
  expect(await local.transcrire(pcm(), { langue: 'en', vocabulaire: 'Ada' })).toEqual({ texte: 'hello world', langue: 'en', logprob: -0.1, sansParole: 0.01, dureeMs: 300 });
  expect(fixture.requests.map((r) => r.path)).toEqual(['/reclasser', '/nli', '/entites', '/vecteurs', '/transcrire']);
  expect(fixture.requests[4].body).toEqual({ audio: pcm(), langue: 'en', vocabulaire: 'Ada' });
  expect(fixture.requests[0].headers['x-delai-ms']).toBe('1000');
});

test('unconfigured server returns unavailable/null without a network call', async () => {
  const local = createLocalModelsClient();
  expect(local.available('/nli')).toBe(false);
  expect(await local.reclasser('q', ['a'])).toBeNull();
  expect(await local.comparer([{ premisse: 'a', hypothese: 'b' }])).toBeNull();
  expect(await local.entites('Ada', ['person'])).toBeNull();
  expect(await local.vecteurs(['a'])).toBeNull();
  expect(await local.transcrire(pcm(), { langue: 'fr' })).toBeNull();
  expect(fixture.requests).toHaveLength(0);
});

test('reads Bearer from an actual file, caches it for a minute and reloads', async () => {
  let time = 1000;
  const tokenFile = join(directory, 'token'); await writeFile(tokenFile, 'fake-bearer-one\n');
  const local = client({ tokenFile, now: () => time });
  await local.reclasser('q', ['a']); await writeFile(tokenFile, 'fake-bearer-two');
  await local.reclasser('q', ['a']); time += 60001; await local.reclasser('q', ['a']);
  expect(fixture.requests.map((r) => r.headers.authorization)).toEqual(['Bearer fake-bearer-one', 'Bearer fake-bearer-one', 'Bearer fake-bearer-two']);
});

test('missing configured token fails closed with a clean error', async () => {
  const errors = []; const local = client({ tokenFile: join(directory, 'absent'), onError: (error) => errors.push(error) });
  expect(await local.reclasser('q', ['a'])).toBeNull();
  expect(errors[0]).toBeInstanceOf(AiServiceError); expect(errors[0].code).toBe('AI_TOKEN_UNAVAILABLE');
  expect(fixture.requests).toHaveLength(0);
});

test('validates every input and rejects bounds before HTTP', async () => {
  const local = client();
  expect(await local.reclasser('', ['a'])).toBeNull();
  expect(await local.reclasser('q', Array(51).fill('a'))).toBeNull();
  expect(await local.nli(Array(21).fill({ premisse: 'a', hypothese: 'b' }))).toBeNull();
  expect(await local.nli([{ premisse: '', hypothese: 'b' }])).toBeNull();
  expect(await local.entites('a'.repeat(8001), ['person'])).toBeNull();
  expect(await local.entites('a', ['p'.repeat(51)])).toBeNull();
  expect(await local.vecteurs(Array(33).fill('a'))).toBeNull();
  expect(await local.vecteurs(['a'.repeat(2001)])).toBeNull();
  expect(await local.transcrire('invalid base64', { langue: 'fr' })).toBeNull();
  expect(await local.transcrire(pcm(), { langue: 'de' })).toBeNull();
  expect(await local.transcrire(pcm(), { langue: 'fr', vocabulaire: 'a'.repeat(601) })).toBeNull();
  expect(validPcmAudio(Buffer.alloc(6398).toString('base64'))).toBe(false);
  expect(validPcmAudio(Buffer.alloc(960002).toString('base64'))).toBe(false);
  expect(fixture.requests).toHaveLength(0);
});

test.each([
  ['/reclasser', { scores: ['bad'] }, (c) => c.reclasser('q', ['a'])],
  ['/nli', { resultats: [{ accord: 2, neutre: 0, contradiction: 0 }] }, (c) => c.nli([{ premisse: 'a', hypothese: 'b' }])],
  ['/entites', { entites: [{ texte: 'Ada', type: 'wrong', debut: 0, fin: 3, score: 1 }] }, (c) => c.entites('Ada', ['person'])],
  ['/vecteurs', { vecteurs: [vector()], modele: 'other', dimensions: 1024 }, (c) => c.vecteurs(['a'])],
  ['/vecteurs', { vecteurs: [[1]], modele: LOCAL_VECTOR_MODEL, dimensions: 1024 }, (c) => c.vecteurs(['a'])],
  ['/transcrire', { texte: 'a', langue: 'fr', logprob: -1, sans_parole: 'bad', duree_ms: 1 }, (c) => c.transcrire(pcm(), { langue: 'fr' })]
])('rejects malformed %s response', async (_path, response, call) => {
  handle = ({ res }) => json(res, response);
  expect(await call(client())).toBeNull();
});

test('independent circuits stop after three failures, allow one probe, then recover', async () => {
  let time = 1000; let finish;
  const local = client({ now: () => time, cooldownMs: 100 });
  handle = ({ res }) => json(res, {}, 500);
  for (let at = 0; at < 3; at++) await local.reclasser('q', ['a']);
  expect(local.available('/reclasser')).toBe(false); expect(local.available('/vecteurs')).toBe(true);
  expect(await local.reclasser('q', ['a'])).toBeNull(); expect(fixture.requests).toHaveLength(3);
  time += 101;
  handle = ({ res }) => { finish = () => json(res, { scores: [0.9] }); };
  const probe = local.reclasser('q', ['a']);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(await local.reclasser('q', ['a'])).toBeNull();
  finish(); expect(await probe).toEqual([0.9]); expect(local.available('/reclasser')).toBe(true);
});

test('4xx refusals do not open circuits; response-body deadlines and caller cancellation are distinct', async () => {
  const local = client(); handle = ({ res }) => json(res, {}, 422);
  for (let at = 0; at < 4; at++) expect(await local.reclasser('q', ['a'])).toBeNull();
  expect(local.available('/reclasser')).toBe(true);
  handle = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); };
  const errors = []; const timed = client({ onError: (e) => errors.push(e) });
  expect(await timed.reclasser('q', ['a'], { timeoutMs: 15 })).toBeNull(); expect(errors[0].code).toBe('AI_SERVICE_TIMEOUT');
  const controller = new globalThis.AbortController(); controller.abort(new Error('left'));
  await expect(local.reclasser('q', ['a'], { signal: controller.signal })).rejects.toThrow('left');
});

test('token reader deduplicates concurrent reads and service errors hide transport details', async () => {
  const read = jest.fn(async () => 'fake'); const token = createTokenFileReader({ tokenFile: 'virtual', read });
  expect(await Promise.all([token(), token()])).toEqual(['fake', 'fake']); expect(read).toHaveBeenCalledTimes(1);
  await expect(serviceRequest('http://example.invalid', { fetch: async () => { throw new Error('private-token'); } })).rejects.toThrow('AI_SERVICE_UNREACHABLE');
});

test('English adapters connect reranking, NLI and masking without duplicating wire contracts', async () => {
  const { rerankResults, findContradiction, createReversibleMasker } = require('../src');
  const local = client();
  expect(await local.rerank('q', ['a'])).toEqual([0]);
  expect(await local.compare([{ premise: 'a', hypothesis: 'b' }])).toEqual([{ entailment: 0.1, neutral: 0.1, contradiction: 0.8 }]);
  expect(await local.entities('😀 Ada', ['person'])).toEqual([{ text: 'Ada', type: 'person', start: 3, end: 6, score: 0.95 }]);
  expect((await local.embed(['a'])).modele).toBe(LOCAL_VECTOR_MODEL);
  const ranked = await rerankResults('q', { results: [{ content: 'a' }, { content: 'b' }] }, { score: local.rerank });
  expect(ranked.results[0].content).toBe('b');
  expect((await findContradiction('Ada studied the same mathematics book.', ['Ada studied the same mathematics book.'], { compare: local.compare })).contradicts).toBe(true);
  handle = ({ res }) => json(res, { entites: [{ texte: 'Ada', type: 'person', debut: 3, fin: 6, score: 0.95 }] });
  const masker = createReversibleMasker({ detect: (value) => local.entities(value, ['person']) });
  expect(await masker.maskAsync('😀 Ada')).not.toContain('Ada');
});
