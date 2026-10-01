const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createPriceCatalog,
  normalizeUsage,
  diffPriceCatalogs,
  bundledCatalogFile,
  loadBundledCatalog
} = require('../src');
const { validateCatalog, parseArgs } = require('../scripts/update-prices');

/* A small catalog in LiteLLM's format: every number below is checkable by hand. */
function fixture() {
  return {
    sample_spec: { litellm_provider: 'one of ...', input_cost_per_token: 0 },
    'gpt-4o': {
      litellm_provider: 'openai', mode: 'chat',
      input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-6,
      max_input_tokens: 128000, max_output_tokens: 16384,
      supports_vision: true, supports_function_calling: true, supports_prompt_caching: true
    },
    'gpt-4o-audio': {
      litellm_provider: 'openai', mode: 'chat',
      input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5,
      input_cost_per_audio_token: 4e-5, output_cost_per_audio_token: 8e-5,
      supports_audio_input: true, supports_audio_output: true
    },
    'claude-sonnet-4-5': {
      litellm_provider: 'anthropic', mode: 'chat',
      input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
      input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 2.25e-5,
      cache_read_input_token_cost_above_200k_tokens: 6e-7,
      max_input_tokens: 1000000, max_output_tokens: 64000,
      supports_reasoning: true, supports_function_calling: true, supports_vision: true
    },
    'gemini/gemini-2.5-flash': {
      litellm_provider: 'gemini', mode: 'chat',
      input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6, output_cost_per_reasoning_token: 2.5e-6,
      cache_read_input_token_cost: 3e-8,
      max_input_tokens: 1048576, max_output_tokens: 65536, supports_reasoning: true
    },
    'gemini-2.5-flash': {
      litellm_provider: 'vertex_ai-language-models', mode: 'chat',
      input_cost_per_token: 9e-7, output_cost_per_token: 9e-6
    },
    'groq/openai/gpt-oss-120b': {
      litellm_provider: 'groq', mode: 'chat',
      input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, max_tokens: 65536
    },
    'groq/whisper-large-v3': { litellm_provider: 'groq', mode: 'audio_transcription', input_cost_per_second: 3e-5 },
    'vercel_ai_gateway/openai/gpt-4o': {
      litellm_provider: 'vercel_ai_gateway', mode: 'chat', input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5
    },
    'dashscope/qwen-flash': {
      litellm_provider: 'dashscope', mode: 'chat',
      tiered_pricing: [
        { range: [0, 256000], input_cost_per_token: 5e-8, output_cost_per_token: 4e-7 },
        { range: [256000, 1000000], input_cost_per_token: 2.5e-7, output_cost_per_token: 2e-6 }
      ]
    },
    'cloudflare/@cf/black-forest-labs/flux-1-schnell': {
      litellm_provider: 'cloudflare', mode: 'image_generation', output_cost_per_image: 0.0011
    },
    'no-price-model': { litellm_provider: 'openai', mode: 'chat' }
  };
}

const at = Date.parse('2026-10-01T12:00:00Z');
const make = (options = {}) => createPriceCatalog({ data: fixture(), date: '2026-10-01', now: () => at, ...options });

describe('lookup: aliases and provider prefixes', () => {
  const catalog = make({
    aliases: [
      { from: 'oracle-rapide', model: 'groq/openai/gpt-oss-120b' },
      { match: '(?i)^gpt-4o-\\d{4}-\\d{2}-\\d{2}$', model: 'gpt-4o' }
    ]
  });

  test.each([
    ['gpt-4o', undefined, 'gpt-4o', 'exact'],
    ['GPT-4o', undefined, 'gpt-4o', 'exact'],
    ['openai/gpt-4o', undefined, 'gpt-4o', 'provider_prefix'],
    ['anthropic/claude-sonnet-4-5', undefined, 'claude-sonnet-4-5', 'provider_prefix'],
    ['google/gemini-2.5-flash', undefined, 'gemini/gemini-2.5-flash', 'provider_prefix'],
    ['gemini-2.5-flash', 'gemini', 'gemini/gemini-2.5-flash', 'provider_prefix'],
    ['models/gemini-2.5-flash', 'google', 'gemini/gemini-2.5-flash', 'provider_prefix'],
    ['openai/gpt-oss-120b', 'groq', 'groq/openai/gpt-oss-120b', 'provider_prefix'],
    ['gpt-oss-120b', 'groq', 'groq/openai/gpt-oss-120b', 'provider_suffix'],
    ['openai/gpt-4o', 'vercel', 'vercel_ai_gateway/openai/gpt-4o', 'provider_prefix'],
    ['vercel/openai/gpt-4o', undefined, 'vercel_ai_gateway/openai/gpt-4o', 'provider_prefix'],
    ['oracle-rapide', undefined, 'groq/openai/gpt-oss-120b', 'alias'],
    ['gpt-4o-2026-08-06', undefined, 'gpt-4o', 'alias']
  ])('%s (provider %s) -> %s', (model, provider, key, matchedBy) => {
    const info = catalog.lookup(model, { provider });
    expect(info).toMatchObject({ ok: true, key, matchedBy });
  });

  test('bare id without provider keeps the bare entry (another provider, other prices)', () => {
    expect(catalog.lookup('gemini-2.5-flash')).toMatchObject({ ok: true, key: 'gemini-2.5-flash' });
  });

  test('a provider is never answered with another provider\'s entry', () => {
    expect(catalog.lookup('gpt-4o', { provider: 'groq' })).toMatchObject({ ok: false, code: 'unknown_model' });
  });

  test('context window and capabilities', () => {
    expect(catalog.contextWindow('openai/gpt-4o')).toEqual({ ok: true, model: 'openai/gpt-4o', key: 'gpt-4o', maxInput: 128000, maxOutput: 16384 });
    // max_tokens fills both when the specific limits are missing
    expect(catalog.contextWindow('gpt-oss-120b', { provider: 'groq' })).toMatchObject({ maxInput: 65536, maxOutput: 65536 });
    expect(catalog.capabilities('gpt-4o')).toMatchObject({ ok: true, vision: true, tools: true, promptCaching: true, reasoning: false, audioInput: false });
    expect(catalog.capabilities('gpt-4o-audio')).toMatchObject({ audioInput: true, audioOutput: true });
    expect(catalog.capabilities('claude-sonnet-4-5')).toMatchObject({ reasoning: true, vision: true });
  });

  test('the spec sample is not a model', () => {
    expect(catalog.lookup('sample_spec')).toMatchObject({ ok: false, code: 'unknown_model' });
    expect(catalog.size).toBe(Object.keys(fixture()).length - 1);
  });
});

describe('unknown model: explicit result, never a silent exception', () => {
  const catalog = make();
  test.each([['nope-9000'], [''], [null], [42]])('%p', (model) => {
    expect(() => catalog.cost(model, { input: 10 })).not.toThrow();
    const result = catalog.cost(model, { input: 10 });
    expect(result).toMatchObject({ ok: false, code: 'unknown_model' });
    expect(typeof result.message).toBe('string');
    expect(catalog.lookup(model)).toMatchObject({ ok: false, code: 'unknown_model' });
    expect(catalog.contextWindow(model)).toMatchObject({ ok: false, code: 'unknown_model' });
  });

  test('unrecognised usage -> invalid_usage', () => {
    expect(catalog.cost('gpt-4o', { tokens: 10 })).toMatchObject({ ok: false, code: 'invalid_usage' });
    expect(catalog.cost('gpt-4o', null)).toMatchObject({ ok: false, code: 'invalid_usage' });
    expect(catalog.cost('gpt-4o', { input: -3 })).toMatchObject({ ok: false, code: 'invalid_usage' });
  });

  test('a used field without any price -> no_price, never a zero cost', () => {
    expect(catalog.cost('no-price-model', { input: 10 })).toMatchObject({ ok: false, code: 'no_price', missing: ['input'] });
    expect(catalog.cost('groq/whisper-large-v3', { input: 10 })).toMatchObject({ ok: false, code: 'no_price' });
  });
});

describe('cost of a call', () => {
  const catalog = make();

  test('input and output', () => {
    const result = catalog.cost('gpt-4o', { input: 1000, output: 500 });
    expect(result).toMatchObject({ ok: true, currency: 'USD', billing: 'paid', source: 'catalog', total: 0.0075, listTotal: 0.0075 });
    expect(result.breakdown).toEqual({ input: 0.0025, output: 0.005 });
  });

  test('cache read and cache write (5 min and 1 h) are billed at their own prices', () => {
    const result = catalog.cost('claude-sonnet-4-5', { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 2000, cacheWrite1h: 1000 });
    expect(result.breakdown).toEqual({ input: 0.003, output: 0.0015, cacheRead: 0.003, cacheWrite: 0.0075, cacheWrite1h: 0.006 });
    expect(result.total).toBeCloseTo(0.021, 12);
  });

  test('a model without a cache price bills cached tokens as input', () => {
    const result = catalog.cost('vercel_ai_gateway/openai/gpt-4o', { input: 0, cacheRead: 1000 });
    expect(result.breakdown).toEqual({ cacheRead: 0.0025 });
    expect(result.unitPrices.cacheRead).toEqual({ price: 'input', perUnit: 2.5e-6 });
  });

  test('audio tokens at audio prices, reasoning at its price', () => {
    expect(catalog.cost('gpt-4o-audio', { input: 100, audioInput: 1000, audioOutput: 500 }).breakdown)
      .toEqual({ input: 0.00025, audioInput: 0.04, audioOutput: 0.04 });
    expect(catalog.cost('gemini/gemini-2.5-flash', { input: 1000, output: 100, reasoning: 400 }).total).toBeCloseTo(0.00155, 12);
  });

  test('per second (transcription) and per image', () => {
    expect(catalog.cost('groq/whisper-large-v3', { seconds: 60 }).total).toBeCloseTo(0.0018, 12);
    expect(catalog.cost('cloudflare/@cf/black-forest-labs/flux-1-schnell', { images: 10 }).total).toBeCloseTo(0.011, 12);
  });

  test('long context: above 200k prompt tokens the whole request moves to the higher tier', () => {
    const below = catalog.cost('claude-sonnet-4-5', { input: 200000, output: 10 });
    expect(below.tier).toBeNull();
    expect(below.total).toBeCloseTo(0.60015, 12);
    const above = catalog.cost('claude-sonnet-4-5', { input: 190000, cacheRead: 20000, output: 10 });
    expect(above.tier).toBe('above_200k_tokens');
    expect(above.breakdown).toEqual({ input: 1.14, output: 0.000225, cacheRead: 0.012 });
  });

  test('tiered_pricing ranges', () => {
    expect(catalog.cost('dashscope/qwen-flash', { input: 1000, output: 1000 }).total).toBeCloseTo(0.00045, 12);
    const big = catalog.cost('dashscope/qwen-flash', { input: 300000, output: 1000 });
    expect(big.tier).toBe('range_256000_1000000');
    expect(big.total).toBeCloseTo(0.077, 12);
  });

  test('vendor usage shapes are made disjoint before pricing', () => {
    // OpenAI: prompt_tokens includes the cached tokens
    const openai = catalog.cost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } });
    expect(openai.usage).toMatchObject({ input: 600, cacheRead: 400, output: 100 });
    expect(openai.total).toBeCloseTo(600 * 2.5e-6 + 400 * 1.25e-6 + 100 * 1e-5, 12);
    // Anthropic: cache fields are separate, 1 h writes split out
    expect(normalizeUsage({
      input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 120,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 20 }
    })).toMatchObject({ input: 50, output: 10, cacheRead: 300, cacheWrite: 100, cacheWrite1h: 20 });
    // Gemini: promptTokenCount includes the cached tokens, thoughts are separate
    expect(normalizeUsage({ promptTokenCount: 1000, candidatesTokenCount: 50, cachedContentTokenCount: 600, thoughtsTokenCount: 30 }))
      .toMatchObject({ input: 400, cacheRead: 600, output: 50, reasoning: 30 });
    // AI SDK: inputTokens includes cachedInputTokens, outputTokens includes reasoningTokens
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 30, reasoningTokens: 10 }))
      .toMatchObject({ input: 70, cacheRead: 30, output: 30, reasoning: 10 });
    // OpenAI Responses: input_tokens includes cached tokens
    expect(normalizeUsage({ input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 15 } }))
      .toMatchObject({ input: 40, cacheRead: 60, output: 25, reasoning: 15 });
  });
});

describe('local overrides win over the catalog', () => {
  test('negotiated price per token or per million, tiers keep the catalog only for fields not overridden', () => {
    const catalog = make({
      overrides: {
        'claude-sonnet-4-5': { pricesPerMillion: { input: 1 }, note: 'contrat 2026' }
      }
    });
    const result = catalog.cost('anthropic/claude-sonnet-4-5', { input: 100000, output: 1000 });
    expect(result).toMatchObject({ source: 'catalog+override', total: 0.115, listTotal: 0.315 });
    // above 200k: input stays at the negotiated price, output takes the catalog surcharge
    const above = catalog.cost('claude-sonnet-4-5', { input: 300000, output: 1000 });
    expect(above.breakdown).toEqual({ input: 0.3, output: 0.0225 });
    expect(catalog.lookup('claude-sonnet-4-5').note).toBe('contrat 2026');
  });

  test('a discount applies to every catalog price, tiers included', () => {
    const catalog = make({ overrides: [{ model: 'claude-sonnet-4-5', discount: 0.5 }] });
    expect(catalog.cost('claude-sonnet-4-5', { input: 1000, output: 1000 }).total).toBeCloseTo(0.009, 12);
    expect(catalog.cost('claude-sonnet-4-5', { input: 300000 }).total).toBeCloseTo(0.9, 12);
  });

  test('free model: billed 0, list value kept', () => {
    const catalog = make({ overrides: { 'gemini/gemini-2.5-flash': { billing: 'free' } } });
    const result = catalog.cost('gemini-2.5-flash', { input: 1000000 }, { provider: 'gemini' });
    expect(result).toMatchObject({ ok: true, billing: 'free', total: 0, listTotal: 0.3, breakdown: {} });
  });

  test('free tier: 0 while it lasts, the catalog price once exhausted', () => {
    const catalog = make({ overrides: [{ match: '(?i)^groq/', billing: 'free_tier' }] });
    const usage = { input: 1000000, output: 1000000 };
    expect(catalog.cost('openai/gpt-oss-120b', usage, { provider: 'groq' })).toMatchObject({ billing: 'free_tier', total: 0, listTotal: 0.75 });
    expect(catalog.cost('openai/gpt-oss-120b', usage, { provider: 'groq', freeTierExhausted: true }))
      .toMatchObject({ billing: 'paid', total: 0.75 });
  });

  test('credits: real amount, charged to a named pool', () => {
    const catalog = make({ overrides: [{ match: /^vercel_ai_gateway\//, billing: 'credits', creditPool: 'vercel-mensuel' }] });
    expect(catalog.cost('openai/gpt-4o', { input: 1000 }, { provider: 'vercel' }))
      .toMatchObject({ billing: 'credits', creditPool: 'vercel-mensuel', total: 0.0025 });
  });

  test('a model absent from the catalog, known only locally', () => {
    const catalog = make({
      overrides: {
        'llama-local': { prices: { input: 0, output: 0 }, contextWindow: { maxInput: 8192 }, capabilities: { tools: true } }
      }
    });
    expect(catalog.lookup('llama-local')).toMatchObject({ ok: true, source: 'override', matchedBy: 'override', contextWindow: { maxInput: 8192 } });
    expect(catalog.capabilities('llama-local')).toMatchObject({ tools: true, vision: false });
    expect(catalog.cost('llama-local', { input: 500, output: 500 })).toMatchObject({ ok: true, total: 0, listTotal: null });
  });

  test('"as" borrows a catalog entry for a local name', () => {
    const catalog = make({ overrides: [{ match: /^mon-gpt$/, as: 'gpt-4o', discount: 0.2 }] });
    expect(catalog.cost('mon-gpt', { input: 1000 })).toMatchObject({ key: 'gpt-4o', total: 0.002, listTotal: 0.0025 });
    const broken = make({ overrides: [{ model: 'x', as: 'absent' }] });
    expect(broken.lookup('x')).toMatchObject({ ok: false, code: 'unknown_model' });
  });

  test('an invalid override is refused at creation', () => {
    expect(() => make({ overrides: { m: { prices: { input: -1 } } } })).toThrow(TypeError);
    expect(() => make({ overrides: { m: { prices: { tokens: 1 } } } })).toThrow(/unknown price/);
    expect(() => make({ overrides: { m: { billing: 'credits' } } })).toThrow(/creditPool/);
    expect(() => make({ overrides: { m: { billing: 'gratuit' } } })).toThrow(/billing/);
    expect(() => make({ overrides: [{ billing: 'free' }] })).toThrow(/model" or "match/);
    expect(() => make({ overrides: { m: { discount: 2 } } })).toThrow(/discount/);
  });
});

describe('a cost is frozen at computation time', () => {
  test('changing the catalog afterwards does not change a recorded cost', () => {
    const data = fixture();
    const catalog = createPriceCatalog({ data, date: '2026-10-01', now: () => at });
    const recorded = catalog.cost('gpt-4o', { input: 1000, output: 1000 });
    data['gpt-4o'].input_cost_per_token = 1;
    expect(recorded.total).toBeCloseTo(0.0125, 12);
    expect(recorded.unitPrices.input.perUnit).toBe(2.5e-6);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.breakdown)).toBe(true);
    expect(() => { 'use strict'; recorded.breakdown.input = 0; }).toThrow(TypeError);
    expect(recorded).toMatchObject({ catalogDate: '2026-10-01', computedAt: '2026-10-01T12:00:00.000Z' });
  });

  test('a lookup result cannot be changed by its reader', () => {
    const catalog = make();
    const info = catalog.lookup('gpt-4o');
    expect(Object.isFrozen(info.prices)).toBe(true);
    expect(catalog.cost('gpt-4o', { input: 1000 }).total).toBe(0.0025);
  });
});

describe('bundled catalog', () => {
  test('the newest dated copy is loaded and holds the usual models', () => {
    const found = bundledCatalogFile();
    expect(path.basename(found.file)).toMatch(/^prix-modeles-\d{4}-\d{2}-\d{2}\.json$/);
    const catalog = createPriceCatalog();
    expect(catalog.date).toBe(found.date);
    expect(catalog.size).toBeGreaterThan(1000);
    for (const [model, provider] of [['gpt-4o'], ['claude-sonnet-4-5'], ['gemini-2.5-flash', 'gemini'], ['openai/gpt-oss-120b', 'groq']]) {
      const result = catalog.cost(model, { input: 1000, output: 1000 }, { provider });
      expect(result.ok).toBe(true);
      expect(result.total).toBeGreaterThan(0);
    }
    expect(loadBundledCatalog()).toBe(loadBundledCatalog());
  });

  test('NOTICE carries the LiteLLM copyright and the MIT licence', () => {
    const notice = fs.readFileSync(path.join(__dirname, '..', 'data', 'NOTICE'), 'utf8');
    expect(notice).toContain('Copyright (c) 2023 Berri AI');
    expect(notice).toContain('MIT License');
    expect(notice).toContain(path.basename(bundledCatalogFile().file));
  });

  test('bundledCatalogFile picks the newest date and survives a missing folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prix-'));
    for (const name of ['prix-modeles-2026-01-05.json', 'prix-modeles-2026-10-01.json', 'autre.json']) fs.writeFileSync(path.join(dir, name), '{}');
    expect(bundledCatalogFile(dir).date).toBe('2026-10-01');
    expect(bundledCatalogFile(path.join(dir, 'absent'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('update script helpers', () => {
  test('diff: added, removed, changed prices', () => {
    const before = fixture();
    const after = fixture();
    delete after['no-price-model'];
    after['new-model'] = { litellm_provider: 'openai', input_cost_per_token: 1e-6 };
    after['gpt-4o'].output_cost_per_token = 2e-5;
    after['gpt-4o'].supports_vision = false; // not a price: not reported
    expect(diffPriceCatalogs(before, after)).toEqual({
      added: ['new-model'],
      removed: ['no-price-model'],
      changed: [{ key: 'gpt-4o', field: 'output_cost_per_token', before: 1e-5, after: 2e-5 }]
    });
  });

  test('a partial or foreign download is refused, arguments are checked', () => {
    expect(() => validateCatalog([])).toThrow();
    expect(() => validateCatalog({ a: { litellm_provider: 'x' } })).toThrow(/partial/);
    expect(() => validateCatalog(loadBundledCatalog().data)).not.toThrow();
    expect(parseArgs(['--dry-run', '--date', '2026-11-02'])).toMatchObject({ dryRun: true, date: '2026-11-02' });
    expect(() => parseArgs(['--url', 'http://insecure'])).toThrow(/https/);
    expect(() => parseArgs(['--date', 'demain'])).toThrow(/YYYY-MM-DD/);
  });
});
