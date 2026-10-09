const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  loadManifest, manifestProblems, listModelFiles, fetchModels, checkModels, assertModelsReady,
  ManifestIncompleteError, ChecksumError, ModelsNotReadyError, serviceEnv
} = require('../src');
const { main } = require('../bin/astratra-models');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const REVISION = 'a'.repeat(40);

/* A tiny manifest over files we serve ourselves, so nothing leaves the machine. */
const FILES = {
  'config.json': Buffer.from('{"id2label":{"0":"SAFE","1":"INJECTION"}}'),
  'onnx/model_quantized.onnx': crypto.randomBytes(300_000),
  'enc/tokenizer.json': Buffer.from('{"tokenizer":true}')
};
function manifestFor(files = FILES, overrides = {}) {
  const entry = (p) => ({ path: p, size: files[p].length, sha256: sha(files[p]) });
  return {
    schema: 1,
    models: {
      injection: {
        folder: 'guard-small', description: 'd', license: 'Apache-2.0',
        sources: [{ repo: 'acme/guard-small', revision: REVISION, files: [entry('config.json'), entry('onnx/model_quantized.onnx')] }],
        ...overrides
      },
      entities: {
        folder: 'ner', description: 'd', license: 'MIT',
        sources: [{ repo: 'acme/ner', revision: REVISION, files: [entry('config.json')] },
          { repo: 'acme/encoder', revision: REVISION, dir: '_dependances/enc', files: [entry('enc/tokenizer.json')] }]
      }
    }
  };
}

let server;
let endpoint;
let hits;
let content;
let failNext;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push({ url: request.url, range: request.headers.range });
    const match = /^\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(request.url);
    const body = match && content[match[3]];
    if (!body) { response.statusCode = 404; response.end(); return; }
    if (failNext > 0) {
      failNext -= 1;
      /* cut the connection half-way: a download that stops */
      response.writeHead(200, { 'Content-Length': body.length });
      response.write(body.subarray(0, Math.floor(body.length / 3)));
      setTimeout(() => response.destroy(), 5);
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
      response.end(body.subarray(start));
    } else {
      response.writeHead(200, { 'Content-Length': body.length });
      response.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
  hits = [];
  content = { ...FILES };
  failNext = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the packaged manifest', () => {
  const manifest = loadManifest();

  test('lists the five existing models and the two guard models', () => {
    expect(Object.keys(manifest.models)).toEqual(['embed', 'rerank', 'nli', 'entities', 'transcribe', 'injection', 'moderation']);
    expect(manifestProblems(manifest)).toEqual([]);
  });

  test('every source is pinned to a commit hash, every file to a SHA-256, every model has a licence', () => {
    for (const [name, model] of Object.entries(manifest.models)) {
      expect(model.license).toBeTruthy();
      for (const source of model.sources) {
        expect(source.revision).toMatch(/^[0-9a-f]{40}$/);
        for (const file of source.files) {
          expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(file.size).toBeGreaterThan(0);
        }
      }
      expect(name).toMatch(/^[a-z]+$/);
    }
  });

  test('model folders are the ones the server looks for by default', () => {
    const folders = Object.fromEntries(Object.entries(manifest.models).map(([n, m]) => [n, m.folder]));
    expect(folders).toEqual({
      embed: 'bge-m3-onnx-int8', rerank: 'gte-reranker-onnx-int8', nli: 'mdeberta-xnli-multilingual',
      entities: 'gliner-multi-v2.1', transcribe: 'faster-whisper-base',
      injection: 'prompt-injection-guard-small', moderation: 'content-safety-guard-small'
    });
  });

  test('the encoder GLiNER names lands in _dependances, next to the models', () => {
    const files = listModelFiles(manifest, ['entities'], '/srv/models');
    expect(files.some((f) => f.relative === '_dependances/mdeberta-v3-base/config.json')).toBe(true);
    expect(files.find((f) => f.relative === 'gliner-multi-v2.1/gliner_config.json').absolute).toBe(path.join('/srv/models', 'gliner-multi-v2.1', 'gliner_config.json'));
  });

  test('serviceEnv accepts the new models', () => {
    expect(serviceEnv({ enabled: ['injection', 'moderation'] }).MODELS_ENABLED).toBe('injection,moderation');
  });
});

describe('manifest validation', () => {
  test('refuses a branch instead of a commit, unsafe paths and bad hashes', () => {
    const bad = manifestFor();
    bad.models.injection.sources[0].revision = 'main';
    bad.models.injection.sources[0].files[0].path = '../escape';
    bad.models.injection.sources[0].files[1].sha256 = 'abc';
    bad.models.entities.sources[1].dir = '/absolute';
    const text = manifestProblems(bad).join('\n');
    expect(text).toMatch(/commit hash/);
    expect(text).toMatch(/unsafe or missing path/);
    expect(text).toMatch(/sha256/);
    expect(text).toMatch(/dir/);
  });
});

describe('fetchModels', () => {
  const options = () => ({ dir, manifest: manifestFor(), endpoint });

  test('downloads the pinned files at the pinned commit and verifies them', async () => {
    const report = await fetchModels(options());
    expect(report.models.injection.downloaded).toEqual(['guard-small/config.json', 'guard-small/onnx/model_quantized.onnx']);
    expect(fs.readFileSync(path.join(dir, 'guard-small', 'onnx', 'model_quantized.onnx')).equals(FILES['onnx/model_quantized.onnx'])).toBe(true);
    expect(fs.existsSync(path.join(dir, '_dependances', 'enc', 'enc', 'tokenizer.json'))).toBe(true);
    expect(hits.every((h) => h.url.includes(`/resolve/${REVISION}/`))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'guard-small')).some((n) => n.endsWith('.part'))).toBe(false);
    expect(checkModels({ dir, manifest: manifestFor() }).ok).toBe(true);
  });

  test('a second run downloads nothing', async () => {
    await fetchModels(options());
    hits = [];
    const report = await fetchModels(options());
    expect(hits).toHaveLength(0);
    expect(report.models.injection.downloaded).toEqual([]);
    expect(report.models.injection.present).toHaveLength(2);
  });

  test('only the models asked for are fetched', async () => {
    await fetchModels({ ...options(), models: ['entities'] });
    expect(fs.existsSync(path.join(dir, 'guard-small'))).toBe(false);
    await expect(fetchModels({ ...options(), models: ['nope'] })).rejects.toThrow(/unknown model: nope/);
  });

  test('a file that differs from its SHA-256 is refused and deleted', async () => {
    content['onnx/model_quantized.onnx'] = crypto.randomBytes(FILES['onnx/model_quantized.onnx'].length);
    await expect(fetchModels(options())).rejects.toBeInstanceOf(ChecksumError);
    const folder = path.join(dir, 'guard-small', 'onnx');
    expect(fs.existsSync(path.join(folder, 'model_quantized.onnx'))).toBe(false);
    expect(fs.existsSync(path.join(folder, 'model_quantized.onnx.part'))).toBe(false);
  });

  test('an altered file already in place is replaced by a verified one', async () => {
    await fetchModels(options());
    const target = path.join(dir, 'guard-small', 'config.json');
    fs.writeFileSync(target, 'tampered');
    expect(checkModels({ dir, manifest: manifestFor() }).models.injection.status).toBe('altered');
    await fetchModels(options());
    expect(fs.readFileSync(target).equals(FILES['config.json'])).toBe(true);
  });

  test('an interrupted download resumes from the bytes already written', async () => {
    failNext = 3;
    await fetchModels({ ...options(), attempts: 5 });
    expect(checkModels({ dir, manifest: manifestFor() }).ok).toBe(true);
    const ranged = hits.filter((h) => h.range);
    expect(ranged.length).toBeGreaterThan(0);
  });

  test('resumes a .part left by an earlier process', async () => {
    const file = FILES['onnx/model_quantized.onnx'];
    fs.mkdirSync(path.join(dir, 'guard-small', 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'guard-small', 'onnx', 'model_quantized.onnx.part'), file.subarray(0, 1000));
    await fetchModels({ ...options(), models: ['injection'] });
    expect(hits.find((h) => h.url.endsWith('model_quantized.onnx')).range).toBe('bytes=1000-');
    expect(checkModels({ dir, manifest: manifestFor(), models: ['injection'] }).ok).toBe(true);
  });

  test('a corrupted .part is caught by the hash and deleted', async () => {
    const file = FILES['onnx/model_quantized.onnx'];
    const part = path.join(dir, 'guard-small', 'onnx', 'model_quantized.onnx.part');
    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, Buffer.concat([Buffer.alloc(1000, 7), file.subarray(1000, 2000)]));
    await expect(fetchModels({ ...options(), models: ['injection'] })).rejects.toBeInstanceOf(ChecksumError);
    expect(fs.existsSync(part)).toBe(false);
  });

  test('a 404 is fatal at once, without retries', async () => {
    delete content['config.json'];
    await expect(fetchModels({ ...options(), attempts: 4 })).rejects.toThrow(/HTTP 404/);
    expect(hits.filter((h) => h.url.endsWith('config.json'))).toHaveLength(1);
  });

  test('refuses to run while a SHA-256 is missing, before any request', async () => {
    for (const missing of [null, 'TO_COMPLETE']) {
      const manifest = manifestFor();
      manifest.models.injection.sources[0].files[1].sha256 = missing;
      hits = [];
      await expect(fetchModels({ dir, manifest, endpoint })).rejects.toBeInstanceOf(ManifestIncompleteError);
      expect(hits).toHaveLength(0);
      expect(() => checkModels({ dir, manifest })).toThrow(ManifestIncompleteError);
      /* a model whose files are complete can still be fetched on its own */
      await expect(fetchModels({ dir, manifest, endpoint, models: ['entities'] })).resolves.toMatchObject({ ok: true });
    }
  });

  test('only https, or http on a loopback address, is accepted as an endpoint', async () => {
    await expect(fetchModels({ ...options(), endpoint: 'http://example.org' })).rejects.toThrow(/https/);
    await expect(fetchModels({ ...options(), endpoint: 'nonsense' })).rejects.toThrow(/absolute URL/);
  });
});

describe('checkModels (offline)', () => {
  test('says ok, missing or altered per model and per file; size mode skips hashing', async () => {
    const manifest = manifestFor();
    expect(checkModels({ dir, manifest }).models.injection.status).toBe('missing');
    await fetchModels({ dir, manifest, endpoint });
    expect(checkModels({ dir, manifest }).ok).toBe(true);
    fs.rmSync(path.join(dir, 'ner', 'config.json'));
    const same = Buffer.from(FILES['config.json']);
    same[2] ^= 1; /* same size, other bytes */
    fs.writeFileSync(path.join(dir, 'guard-small', 'config.json'), same);
    const report = checkModels({ dir, manifest });
    expect(report.ok).toBe(false);
    expect(report.models.entities.status).toBe('missing');
    expect(report.models.injection).toMatchObject({ status: 'altered', files: [{ path: 'guard-small/config.json', status: 'altered' }, { status: 'ok' }] });
    expect(checkModels({ dir, manifest, models: ['injection'], verify: 'size' }).ok).toBe(true);
  });
});

describe('assertModelsReady', () => {
  const manifest = manifestFor();

  test('passes when the models are in place and match', async () => {
    await fetchModels({ dir, manifest, endpoint });
    expect(assertModelsReady({ required: ['injection'], dir, manifest, production: true })).toEqual({ ok: true, production: true, problems: [] });
  });

  test('in production, a missing model stops the start with a clear message', () => {
    expect(() => assertModelsReady({ required: ['injection'], dir, manifest, production: true }))
      .toThrow(/model "injection" is missing .*run astratra-models fetch/);
    try {
      assertModelsReady({ required: ['injection', 'entities'], dir, manifest, production: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelsNotReadyError);
      expect(error.code).toBe('MODELS_NOT_READY');
      expect(error.problems.map((p) => p.model)).toEqual(['injection', 'entities']);
    }
  });

  test('in production, an altered file is named', async () => {
    await fetchModels({ dir, manifest, endpoint });
    const same = Buffer.from(FILES['config.json']);
    same[2] ^= 1;
    fs.writeFileSync(path.join(dir, 'guard-small', 'config.json'), same);
    expect(() => assertModelsReady({ required: ['injection'], dir, manifest, production: true }))
      .toThrow(/model "injection" is altered \(file guard-small\/config.json\)/);
  });

  test('outside production it reports without throwing, unless strict', () => {
    const report = assertModelsReady({ required: ['injection'], dir, manifest, production: false });
    expect(report).toMatchObject({ ok: false, problems: [{ model: 'injection', status: 'missing' }] });
    expect(() => assertModelsReady({ required: ['injection'], dir, manifest, production: false, strict: true })).toThrow(ModelsNotReadyError);
  });

  test('production is read from NODE_ENV and the directory from MODELS_DIR', async () => {
    await fetchModels({ dir, manifest, endpoint });
    expect(assertModelsReady({ required: ['injection'], manifest, env: { NODE_ENV: 'production', MODELS_DIR: dir } }).ok).toBe(true);
    expect(() => assertModelsReady({ required: ['injection'], manifest, env: { NODE_ENV: 'production' } })).toThrow(/missing/);
    expect(assertModelsReady({ required: ['injection'], manifest, env: {} }).production).toBe(false);
  });

  test('refuses an empty or unknown requirement list', () => {
    expect(() => assertModelsReady({ dir, manifest })).toThrow(/required/);
    expect(() => assertModelsReady({ required: [], dir, manifest })).toThrow(/required/);
    expect(() => assertModelsReady({ required: ['gpt'], dir, manifest })).toThrow(/unknown model/);
  });
});

describe('astratra-models command', () => {
  function run(args, extraEnv = {}) {
    const out = [];
    const err = [];
    const previous = process.env.MODELS_DIR;
    delete process.env.MODELS_DIR;
    Object.assign(process.env, extraEnv);
    return main(args, { write: (t) => out.push(t) }, { write: (t) => err.push(t) })
      .then((code) => ({ code, out: out.join(''), err: err.join('') }))
      .finally(() => { if (previous === undefined) delete process.env.MODELS_DIR; else process.env.MODELS_DIR = previous; });
  }

  test('usage and errors', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--help'])).out).toMatch(/astratra-models fetch/);
    expect((await run(['upload'])).code).toBe(2);
    expect((await run(['fetch', '--bogus'])).code).toBe(2);
    expect((await run(['fetch', '--check'])).err).toMatch(/models directory is required/);
    expect((await run(['fetch', '--check', '--dir', dir, '--models', 'nope'])).code).toBe(2);
  });

  test('--check is offline: missing models give exit 1, listing them', async () => {
    const result = await run(['fetch', '--check', '--dir', dir, '--models', 'injection,moderation']);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/missing\s+injection/);
  });

  test('--check --json prints the report; MODELS_DIR is the default directory', async () => {
    const result = await run(['fetch', '--check', '--json', '--models', 'injection'], { MODELS_DIR: dir });
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, models: { injection: { status: 'missing' } } });
  });

  test('list shows every model with its licence', async () => {
    const result = await run(['list']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/injection\s+\d+ MB\s+Apache-2.0\s+Horizon-Labs\/prompt-injection-guard-small@[0-9a-f]{8}/);
    expect(result.out.trim().split('\n')).toHaveLength(7);
  });
});
