/* global AbortController */
const { createModelsClient, DEFAULT_LIMITS, RESULT_CODES, createEndpointBreaker } = require('../src');
const { fakeFetch, ok, error } = require('./helpers');

const VECTOR = [0.6, 0.8];
const noSleep = () => Promise.resolve();

function client(handler, options = {}) {
  const fetch = fakeFetch(handler);
  return { fetch, models: createModelsClient({ fetch, sleep: noSleep, random: () => 0.5, ...options }) };
}

describe('createModelsClient', () => {
  test('requires a fetch and an http(s) base URL', () => {
    const original = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      expect(() => createModelsClient()).toThrow(/fetch/);
    } finally {
      globalThis.fetch = original;
    }
    expect(() => createModelsClient({ fetch: () => {}, baseUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => createModelsClient({ fetch: () => {}, baseUrl: 'not a url' })).toThrow(/http/);
  });

  test('default base URL is the loopback port 5007, trailing slashes dropped', async () => {
    const a = client(() => ok({ vectors: [VECTOR], model: 'm', dimensions: 2 }));
    await a.models.embed(['a']);
    expect(a.fetch.calls[0].url).toBe('http://127.0.0.1:5007/embed');
    const b = client(() => ok({ vectors: [VECTOR], model: 'm', dimensions: 2 }), { baseUrl: 'http://10.0.0.5:9000///' });
    await b.models.embed(['a']);
    expect(b.fetch.calls[0].url).toBe('http://10.0.0.5:9000/embed');
  });

  test('sends the token as a bearer header, static or read at each call', async () => {
    let n = 0;
    const { fetch, models } = client(() => ok({ scores: [1], model: 'r' }), { token: () => `token-${++n}` });
    await models.rerank('q', ['a']);
    await models.rerank('q', ['a']);
    expect(fetch.calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    const anonymous = client(() => ok({ scores: [1] }));
    await anonymous.models.rerank('q', ['a']);
    expect(anonymous.fetch.calls[0].init.headers.Authorization).toBeUndefined();
  });

  test('exports every result code it can produce', () => {
    expect(RESULT_CODES).toEqual(expect.arrayContaining(['invalid_input', 'circuit_open', 'model_mismatch', 'timeout']));
  });
});

describe('embed', () => {
  test('returns the vectors with the model id and dimensions', async () => {
    const { fetch, models } = client(() => ok({ vectors: [VECTOR, [1, 0]], model: 'bge-m3-onnx-int8', dimensions: 2 }));
    await expect(models.embed(['a', 'b'])).resolves.toEqual({
      ok: true, vectors: [VECTOR, [1, 0]], model: 'bge-m3-onnx-int8', dimensions: 2
    });
    expect(fetch.calls[0].body).toEqual({ texts: ['a', 'b'] });
    expect(fetch.calls[0].init.method).toBe('POST');
  });

  test('refuses another embedding model than the expected one', async () => {
    const { models } = client(() => ok({ vectors: [VECTOR], model: 'other-model', dimensions: 2 }), { embedModel: 'bge-m3-onnx-int8' });
    await expect(models.embed(['a'])).resolves.toMatchObject({
      ok: false, code: 'model_mismatch', model: 'other-model', expected: 'bge-m3-onnx-int8'
    });
    expect(models.available('embed')).toBe(true);
  });

  test('bad responses: count, empty vector, mixed dimensions, non-numbers, no model id', async () => {
    const answers = [
      { vectors: [VECTOR], model: 'm' },
      { vectors: [[]], model: 'm' },
      { vectors: [VECTOR, [1]], model: 'm' },
      { vectors: [[0.1, 'x']], model: 'm' },
      { vectors: [VECTOR] },
      { vectors: [VECTOR], model: 'm', dimensions: 3 },
      {}
    ];
    const inputs = [['a', 'b'], ['a'], ['a', 'b'], ['a'], ['a'], ['a'], ['a']];
    for (let i = 0; i < answers.length; i += 1) {
      const { models } = client(() => ok(answers[i]));
      await expect(models.embed(inputs[i])).resolves.toMatchObject({ ok: false, code: 'bad_response' });
    }
  });

  test('invalid input is refused without calling the server', async () => {
    const { fetch, models } = client(() => ok({}));
    for (const texts of [[], Array(33).fill('a'), ['a', ' '], ['x'.repeat(2001)], [3], 'a', null]) {
      await expect(models.embed(texts)).resolves.toMatchObject({ ok: false, code: 'invalid_input', retryable: false });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test('limits are configurable', async () => {
    const { fetch, models } = client(() => ok({ vectors: [VECTOR, VECTOR, VECTOR], model: 'm' }), { limits: { embedMaxBatch: 2 } });
    await expect(models.embed(['a', 'b', 'c'])).resolves.toMatchObject({ code: 'invalid_input' });
    expect(fetch.calls).toHaveLength(0);
    expect(DEFAULT_LIMITS.embedMaxBatch).toBe(32);
  });
});

describe('rerank', () => {
  test('returns scores in document order and cuts long texts before sending', async () => {
    const { fetch, models } = client(() => ok({ scores: [0.1, 0.9], model: 'gte' }));
    await expect(models.rerank('q', ['a', 'b'.repeat(5000)])).resolves.toEqual({ ok: true, scores: [0.1, 0.9], model: 'gte' });
    expect(fetch.calls[0].body.documents[1]).toHaveLength(2000);
  });

  test('bad responses and invalid inputs', async () => {
    const wrongCount = client(() => ok({ scores: [0.5] }));
    await expect(wrongCount.models.rerank('q', ['a', 'b'])).resolves.toMatchObject({ code: 'bad_response' });
    const notNumber = client(() => ok({ scores: [0.5, 'x'] }));
    await expect(notNumber.models.rerank('q', ['a', 'b'])).resolves.toMatchObject({ code: 'bad_response' });
    const { fetch, models } = client(() => ok({}));
    for (const [query, documents] of [['', ['a']], ['q', []], ['q', Array(51).fill('a')], ['q', ['a', 3]]]) {
      await expect(models.rerank(query, documents)).resolves.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('nli', () => {
  const pairs = [{ premise: 'p', hypothesis: 'h' }];

  test('returns the three probabilities per pair', async () => {
    const results = [{ entailment: 0.1, neutral: 0.1, contradiction: 0.8 }];
    const { fetch, models } = client(() => ok({ results, model: 'mdeberta' }));
    await expect(models.nli(pairs)).resolves.toEqual({ ok: true, results, model: 'mdeberta' });
    expect(fetch.calls[0].body).toEqual({ pairs });
  });

  test('bad responses and invalid inputs', async () => {
    const missing = client(() => ok({ results: [{ entailment: 0.1, neutral: 0.9 }] }));
    await expect(missing.models.nli(pairs)).resolves.toMatchObject({ code: 'bad_response' });
    const count = client(() => ok({ results: [] }));
    await expect(count.models.nli(pairs)).resolves.toMatchObject({ code: 'bad_response' });
    const { fetch, models } = client(() => ok({}));
    for (const value of [[], Array(21).fill(pairs[0]), [{ premise: 'p' }], [null]]) {
      await expect(models.nli(value)).resolves.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('entities', () => {
  const found = [{ text: 'Ada Lovelace', label: 'person', start: 0, end: 12, score: 0.97 }];

  test('returns entities; labels optional (server default)', async () => {
    const { fetch, models } = client(() => ok({ entities: found, model: 'gliner' }));
    await expect(models.entities('Ada Lovelace came.', ['person'])).resolves.toEqual({ ok: true, entities: found, model: 'gliner' });
    await models.entities('Ada Lovelace came.');
    await models.entities('Ada Lovelace came.', { timeoutMs: 300 });
    expect(fetch.calls.map((c) => c.body)).toEqual([
      { text: 'Ada Lovelace came.', labels: ['person'] }, { text: 'Ada Lovelace came.' }, { text: 'Ada Lovelace came.' }
    ]);
  });

  test('refuses malformed entities and offsets outside the text', async () => {
    for (const entity of [{ text: 'X', label: 'person' }, { ...found[0], start: 5, end: 2 },
      { ...found[0], end: 99 }, { ...found[0], start: -1 }, { ...found[0], start: 0.5 }]) {
      const { models } = client(() => ok({ entities: [entity] }));
      await expect(models.entities('Ada Lovelace came.', ['person'])).resolves.toMatchObject({ code: 'bad_response' });
    }
    const empty = client(() => ok(null));
    await expect(empty.models.entities('X', ['person'])).resolves.toMatchObject({ code: 'bad_response' });
  });

  test('invalid inputs, including label length the source client let through', async () => {
    const { fetch, models } = client(() => ok({}));
    for (const [text, labels] of [['', ['person']], ['x'.repeat(8001), ['person']], ['x', []],
      ['x', ['l'.repeat(51)]], ['x', Array(11).fill('a')], ['x', [5]]]) {
      await expect(models.entities(text, labels)).resolves.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('transcribe', () => {
  const answer = { text: 'How many absences?', language: 'en', avg_logprob: -0.3, no_speech_prob: 0.05, duration_ms: 420, audio_ms: 1000, model: 'fw-base' };
  const second = Buffer.alloc(32000);

  test('sends base64 PCM, language and prompt; maps the answer to camelCase', async () => {
    const { fetch, models } = client(() => ok(answer));
    await expect(models.transcribe(second, { language: 'en', prompt: 'Ada' })).resolves.toEqual({
      ok: true, text: 'How many absences?', language: 'en', avgLogprob: -0.3, noSpeechProb: 0.05,
      durationMs: 420, audioMs: 1000, model: 'fw-base'
    });
    expect(fetch.calls[0].body).toEqual({ audio: second.toString('base64'), language: 'en', prompt: 'Ada' });
  });

  test('accepts base64 text, auto language and the vad flag', async () => {
    const { fetch, models } = client(() => ok(answer));
    await models.transcribe(second.toString('base64'), { vad: true });
    expect(fetch.calls[0].body).toEqual({ audio: second.toString('base64'), language: null, prompt: '', vad: true });
  });

  test('an empty text is an answer (silence), not a failure', async () => {
    const { models } = client(() => ok({ ...answer, text: '' }));
    await expect(models.transcribe(second)).resolves.toMatchObject({ ok: true, text: '' });
  });

  test('refuses bad audio, language, prompt or vad locally — including what the source let through', async () => {
    const { fetch, models } = client(() => ok(answer));
    const cases = [
      ['', {}], ['not base64!', {}], [Buffer.alloc(3), {}], [Buffer.alloc(1000), {}],
      [Buffer.alloc(31 * 32000), {}], [second, { language: 'french' }], [second, { prompt: 'x'.repeat(601) }],
      [second, { prompt: 3 }], [second, { vad: 'yes' }], [42, {}]
    ];
    for (const [audio, options] of cases) {
      await expect(models.transcribe(audio, options)).resolves.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test('malformed answer is bad_response; one attempt by default', async () => {
    const { fetch, models } = client(() => ({ status: 500, body: {} }));
    await expect(models.transcribe(second)).resolves.toMatchObject({ code: 'server_error' });
    expect(fetch.calls).toHaveLength(1);
    const bad = client(() => ok({ text: 'x', avg_logprob: 'low' }));
    await expect(bad.models.transcribe(second)).resolves.toMatchObject({ code: 'bad_response' });
  });
});

describe('status codes become result codes', () => {
  const cases = [
    [error(400, 'invalid_input'), 'invalid_input', false],
    [error(401, 'unauthorized'), 'unauthorized', false],
    [error(404, 'not_found'), 'not_found', false],
    [error(413, 'payload_too_large'), 'payload_too_large', false],
    [error(503, 'model_unavailable'), 'model_unavailable', false],
    [error(503, 'model_not_configured'), 'model_not_configured', false],
    [error(503, 'memory_limit'), 'memory_limit', false],
    [error(503, 'busy'), 'busy', true],
    [{ status: 503, body: null }, 'unavailable', true],
    [error(500, 'internal_error'), 'server_error', true],
    [{ status: 502, raw: '<html>' }, 'server_error', true]
  ];
  test.each(cases)('%j -> %s', async (answer, code, retryable) => {
    const { models } = client(() => answer, { retry: { attempts: 1 } });
    const result = await models.rerank('q', ['a']);
    expect(result).toMatchObject({ ok: false, code, retryable, endpoint: 'rerank', status: answer.status });
  });

  test('the server message is kept on refusals', async () => {
    const { models } = client(() => error(400, 'invalid_input'));
    await expect(models.rerank('q', ['a'])).resolves.toMatchObject({ message: 'invalid_input message' });
  });

  test('200 with invalid JSON is bad_response; network failure is network_error', async () => {
    const invalid = client(() => ({ status: 200, raw: 'x' }));
    await expect(invalid.models.rerank('q', ['a'])).resolves.toMatchObject({ code: 'bad_response' });
    const down = client(() => { throw new Error('ECONNREFUSED'); }, { retry: { attempts: 1 } });
    await expect(down.models.rerank('q', ['a'])).resolves.toMatchObject({ code: 'network_error', retryable: true });
  });
});

describe('timeouts and aborts', () => {
  test('per-endpoint default timeout, overridable per call', async () => {
    const { models } = client(() => 'hang', { timeouts: { rerank: 20 } });
    const started = Date.now();
    await expect(models.rerank('q', ['a'])).resolves.toMatchObject({ code: 'timeout', retryable: false });
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(models.rerank('q', ['a'], { timeoutMs: 10 })).resolves.toMatchObject({ code: 'timeout' });
  });

  test('timeouts are not retried unless asked', async () => {
    const plain = client(() => 'hang', { timeouts: { embed: 10 } });
    await plain.models.embed(['a']);
    expect(plain.fetch.calls).toHaveLength(1);
    const eager = client(() => 'hang', { timeouts: { embed: 10 }, retry: { retryTimeouts: true } });
    await eager.models.embed(['a']);
    expect(eager.fetch.calls).toHaveLength(2);
  });

  test('a caller abort is reported as aborted and does not trip the breaker', async () => {
    const { models } = client(() => 'hang');
    for (let i = 0; i < 4; i += 1) {
      const controller = new AbortController();
      const pending = models.nli([{ premise: 'p', hypothesis: 'h' }], { signal: controller.signal });
      controller.abort();
      await expect(pending).resolves.toMatchObject({ code: 'aborted' });
    }
    expect(models.available('nli')).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(models.nli([{ premise: 'p', hypothesis: 'h' }], { signal: aborted.signal })).resolves.toMatchObject({ code: 'aborted' });
  });
});

describe('retries', () => {
  test('retries network errors with full jitter, then succeeds', async () => {
    const delays = [];
    const events = [];
    const { fetch, models } = client((_url, _init, n) => {
      if (n === 1) throw new Error('reset');
      return ok({ scores: [0.4], model: 'r' });
    }, { sleep: async (ms) => { delays.push(ms); }, random: () => 0.5, retry: { baseDelayMs: 100 }, onEvent: (e) => events.push(e) });
    await expect(models.rerank('q', ['a'])).resolves.toMatchObject({ ok: true, scores: [0.4] });
    expect(fetch.calls).toHaveLength(2);
    expect(delays).toEqual([50]);
    expect(events).toEqual([{ type: 'retry', endpoint: 'rerank', code: 'network_error', attempt: 1, delayMs: 50 }]);
  });

  test('backoff grows and is capped', async () => {
    const delays = [];
    const { fetch, models } = client(() => error(503, 'busy'), {
      sleep: async (ms) => { delays.push(ms); }, random: () => 1, retry: { attempts: 5, baseDelayMs: 100, maxDelayMs: 300 }, breaker: false
    });
    await expect(models.embed(['a'])).resolves.toMatchObject({ code: 'busy' });
    expect(fetch.calls).toHaveLength(5);
    expect(delays).toEqual([100, 200, 300, 300]);
  });

  test('refusals and permanent failures are never retried', async () => {
    for (const answer of [error(400, 'invalid_input'), error(401, 'unauthorized'), error(503, 'model_unavailable'), error(413, 'payload_too_large')]) {
      const { fetch, models } = client(() => answer, { retry: { attempts: 4 } });
      await models.embed(['a']);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  test('attempts per endpoint and per call', async () => {
    const { fetch, models } = client(() => { throw new Error('down'); }, { retry: { attempts: { entities: 3 } }, breaker: false });
    await models.entities('x', ['person']);
    expect(fetch.calls).toHaveLength(3);
    await models.nli([{ premise: 'p', hypothesis: 'h' }], { attempts: 1 });
    expect(fetch.calls).toHaveLength(4);
  });
});

describe('circuit breaker, one per endpoint', () => {
  function clock() {
    let t = Date.parse('2026-09-28T10:00:00Z');
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test('three failed calls open it for 60 s, then one probe', async () => {
    const time = clock();
    let answer = () => { throw new Error('ECONNREFUSED'); };
    const { fetch, models } = client(() => answer(), { now: time.now, retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await models.rerank('q', ['a']);
    expect(fetch.calls).toHaveLength(3);
    expect(models.available('rerank')).toBe(false);
    await expect(models.rerank('q', ['a'])).resolves.toMatchObject({ code: 'circuit_open', retryInMs: 60_000 });
    expect(fetch.calls).toHaveLength(3);
    time.advance(60_001);
    expect(models.available('rerank')).toBe(true);
    answer = () => ok({ scores: [0.4] });
    await expect(models.rerank('q', ['a'])).resolves.toMatchObject({ ok: true });
    expect(models.breakerStatus('rerank')).toMatchObject({ state: 'closed', failures: 0 });
  });

  test('a failed probe re-opens at once', async () => {
    const time = clock();
    const { fetch, models } = client(() => { throw new Error('down'); }, { now: time.now, retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await models.embed(['a']);
    time.advance(60_001);
    await models.embed(['a']);
    expect(fetch.calls).toHaveLength(4);
    await expect(models.embed(['a'])).resolves.toMatchObject({ code: 'circuit_open' });
    expect(fetch.calls).toHaveLength(4);
  });

  test('a down reranker does not switch off the other endpoints', async () => {
    const time = clock();
    const { models } = client((url) => {
      if (url.endsWith('/rerank')) throw new Error('down');
      if (url.endsWith('/entities')) return ok({ entities: [] });
      return ok({ vectors: [VECTOR], model: 'm' });
    }, { now: time.now, retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await models.rerank('q', ['a']);
    expect(models.available('rerank')).toBe(false);
    await expect(models.entities('Ada', ['person'])).resolves.toMatchObject({ ok: true });
    await expect(models.embed(['a'])).resolves.toMatchObject({ ok: true });
    expect(models.available('entities')).toBe(true);
  });

  test('failures of different endpoints do not add up; a success resets the count', async () => {
    let fail = true;
    const { models } = client(() => { if (fail) throw new Error('down'); return ok({ scores: [1] }); }, { retry: { attempts: 1 } });
    await models.rerank('q', ['a']);
    await models.rerank('q', ['a']);
    await models.entities('x', ['person']);
    await models.entities('x', ['person']);
    expect(models.available('rerank')).toBe(true);
    fail = false;
    await models.rerank('q', ['a']);
    fail = true;
    await models.rerank('q', ['a']);
    await models.rerank('q', ['a']);
    expect(models.available('rerank')).toBe(true);
  });

  test('a malformed answer counts as a failure; an invalid-input refusal does not', async () => {
    const malformed = client(() => ok({ scores: 'n/a' }), { retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await malformed.models.rerank('q', ['a']);
    expect(malformed.models.available('rerank')).toBe(false);
    const refused = client(() => error(400, 'invalid_input'));
    for (let i = 0; i < 5; i += 1) await refused.models.rerank('q', ['a']);
    expect(refused.models.available('rerank')).toBe(true);
    expect(refused.fetch.calls).toHaveLength(5);
  });

  test('retries inside one call count as one failure', async () => {
    const { fetch, models } = client(() => { throw new Error('down'); }, { retry: { attempts: 2 } });
    await models.embed(['a']);
    await models.embed(['a']);
    expect(fetch.calls).toHaveLength(4);
    expect(models.available('embed')).toBe(true);
  });

  test('an injected breaker (resilience shape) is used, and its refusal is circuit_open', async () => {
    const created = [];
    const createBreaker = (endpoint) => {
      const breaker = createEndpointBreaker({ name: endpoint, failureThreshold: 1 });
      created.push(endpoint);
      return breaker;
    };
    const { fetch, models } = client(() => { throw new Error('down'); }, { createBreaker, retry: { attempts: 1 } });
    await models.nli([{ premise: 'p', hypothesis: 'h' }]);
    await expect(models.nli([{ premise: 'p', hypothesis: 'h' }])).resolves.toMatchObject({ code: 'circuit_open' });
    expect(fetch.calls).toHaveLength(1);
    expect(created).toEqual(['nli']);
    const minimal = client(() => ok({ scores: [1] }), { createBreaker: () => ({ call: (fn) => fn() }) });
    expect(minimal.models.available('rerank')).toBe(true);
    expect(minimal.models.breakerStatus('rerank')).toBeNull();
  });

  test('breaker: false disables it; resetBreakers closes every door', async () => {
    const none = client(() => { throw new Error('down'); }, { breaker: false, retry: { attempts: 1 } });
    for (let i = 0; i < 5; i += 1) await none.models.embed(['a']);
    expect(none.fetch.calls).toHaveLength(5);
    expect(none.models.available('embed')).toBe(true);
    const time = clock();
    const some = client(() => { throw new Error('down'); }, { now: time.now, retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await some.models.embed(['a']);
    expect(some.models.available('embed')).toBe(false);
    some.models.resetBreakers();
    expect(some.models.available('embed')).toBe(true);
  });

  test('events: failure, circuit_open and breaker transitions — never the texts', async () => {
    const events = [];
    const { models } = client(() => { throw new Error('down'); }, { retry: { attempts: 1 }, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 4; i += 1) await models.embed(['very private text']);
    expect(events.map((e) => e.type)).toEqual(['failure', 'failure', 'breaker', 'failure', 'circuit_open']);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  test('an observer that throws never breaks a call', async () => {
    const { models } = client(() => { throw new Error('down'); }, { onEvent: () => { throw new Error('observer'); } });
    await expect(models.embed(['a'])).resolves.toMatchObject({ code: 'network_error' });
  });
});

describe('health', () => {
  test('returns the model statuses and bypasses the breakers', async () => {
    const time = { t: 0 };
    let down = true;
    const models = { embed: { configured: true, loaded: true, failed: false, model: 'bge' } };
    const { fetch, models: api } = client((url) => {
      if (url.endsWith('/health')) return ok({ status: 'ok', version: '0.1.0', models });
      if (down) throw new Error('down');
      return ok({});
    }, { now: () => time.t, retry: { attempts: 1 } });
    for (let i = 0; i < 3; i += 1) await api.embed(['a']);
    await expect(api.health()).resolves.toEqual({ ok: true, version: '0.1.0', models });
    expect(fetch.calls[3].init.method).toBe('GET');
    expect(fetch.calls[3].init.body).toBeUndefined();
    const broken = client(() => ok({ status: 'down' }));
    await expect(broken.models.health()).resolves.toMatchObject({ code: 'bad_response' });
  });
});

describe('asMemoryEmbed', () => {
  test('returns the vector with the model id as source', async () => {
    const { models } = client(() => ok({ vectors: [VECTOR], model: 'bge-m3-onnx-int8' }));
    await expect(models.asMemoryEmbed()('hello', { purpose: 'query' })).resolves.toEqual({ vector: VECTOR, source: 'bge-m3-onnx-int8' });
  });

  test('throws with the code when unavailable (memory keeps the record without a vector)', async () => {
    const { models } = client(() => error(503, 'model_unavailable'));
    await expect(models.asMemoryEmbed()('hello')).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});
