/* The Node client against the REAL server/app.py (stub backends, no model):
   proves both sides agree on routes, field names, auth and error codes.
   Skipped when no python3 is on the PATH. */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { createModelsClient } = require('../src');

const PYTHON = process.env.PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;
const TOKEN = 'contract-token-of-enough-length';

const LAUNCHER = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'server'))})
import app

class Seg:
    def __init__(s, t): s.text, s.tokens, s.avg_logprob, s.no_speech_prob = t, [0, 0], -0.25, 0.05

class Embed:
    def embed(s, texts): return [[0.6, 0.8] for _ in texts]
class Rerank:
    def score(s, q, docs): return [0.9 if q in d else 0.1 for d in docs]
class Nli:
    def classify(s, pairs): return [{'entailment': 0.1, 'neutral': 0.1, 'contradiction': 0.8} for _ in pairs]
class Entities:
    def predict(s, chunks, labels, threshold):
        return [[{'text': 'Ada', 'label': labels[0], 'start': c.find('Ada'), 'end': c.find('Ada') + 3, 'score': 0.9}] if 'Ada' in c else [] for c in chunks]
class Transcribe:
    def transcribe(s, pcm, language, prompt, vad): return [Seg(' Hello')], language or 'en'

def broken():
    raise OSError('missing')

config = app.load_config(env={}, overrides={'port': 0, 'preload': False, 'token': ${JSON.stringify(TOKEN)},
    'models': {n: {'id': n + '-id'} for n in app.MODEL_NAMES}})
server = app.create_server(config, {'embed': Embed, 'rerank': Rerank, 'nli': Nli, 'entities': Entities,
    'transcribe': Transcribe}, rss_reader=lambda: 0.0)
server.models.slots['nli'].factory = broken
print(json.dumps({'port': server.server_address[1]}), flush=True)
server.serve_forever()
`;

const describeIf = hasPython ? describe : describe.skip;

describeIf('client <-> server/app.py contract', () => {
  let child;
  let baseUrl;

  beforeAll(async () => {
    child = spawn(PYTHON, ['-c', LAUNCHER], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/\{"port": (\d+)\}/);
        if (match) resolve(Number(match[1]));
      });
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (child) child.kill();
  });

  const api = (options = {}) => createModelsClient({ baseUrl, token: TOKEN, breaker: false, ...options });

  test('embed, rerank, entities and transcribe round-trip', async () => {
    const models = api();
    await expect(models.embed(['a', 'b'])).resolves.toEqual({ ok: true, vectors: [[0.6, 0.8], [0.6, 0.8]], model: 'embed-id', dimensions: 2 });
    await expect(models.rerank('cat', ['a cat', 'a dog'])).resolves.toEqual({ ok: true, scores: [0.9, 0.1], model: 'rerank-id' });
    await expect(models.entities('Hi Ada.', ['person'])).resolves.toEqual({
      ok: true, entities: [{ text: 'Ada', label: 'person', start: 3, end: 6, score: 0.9 }], model: 'entities-id'
    });
    await expect(models.transcribe(Buffer.alloc(32000), { language: 'fr', prompt: 'Ada' })).resolves.toMatchObject({
      ok: true, text: 'Hello', language: 'fr', avgLogprob: -0.25, noSpeechProb: 0.05, audioMs: 1000, model: 'transcribe-id'
    });
  });

  test('a model that fails to load is model_unavailable; health says so', async () => {
    const models = api();
    await expect(models.nli([{ premise: 'p', hypothesis: 'h' }])).resolves.toMatchObject({ ok: false, code: 'model_unavailable', status: 503 });
    const health = await models.health();
    expect(health.ok).toBe(true);
    expect(health.models.nli).toEqual({ configured: true, loaded: false, failed: true, model: 'nli-id' });
  });

  test('wrong token is unauthorized; oversized text is invalid_input on both sides', async () => {
    await expect(api({ token: 'wrong-token-of-enough-length' }).embed(['a'])).resolves.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(api({ limits: { embedMaxChars: 10_000 } }).embed(['x'.repeat(3000)])).resolves.toMatchObject({ code: 'invalid_input', status: 400 });
  });

  test('a request over the body limit is payload_too_large', async () => {
    const models = api({ limits: { rerankMaxChars: 1_000_000 } });
    await expect(models.rerank('q', ['x'.repeat(300_000)])).resolves.toMatchObject({ code: 'payload_too_large', status: 413 });
  });
});
