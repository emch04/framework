/**
 * Model price catalog: what a call to a hosted model costs, its context
 * window and its capabilities.
 *
 * Data: a dated copy of LiteLLM's `model_prices_and_context_window.json`
 * (MIT, see data/NOTICE), kept verbatim in data/prix-modeles-YYYY-MM-DD.json.
 * Local overrides (negotiated prices, free models, free tiers, credit pools)
 * always win over the catalog.
 *
 * Nothing here throws on an unknown model or an unusable usage object: every
 * answer is `{ ok: true, ... }` or `{ ok: false, code, model, message }`.
 * Only an invalid configuration (bad override, bad alias) throws, at creation.
 *
 * A computed cost is a frozen snapshot: it carries copies of the unit prices
 * it used and the catalog date, so a later catalog update or override change
 * never alters a cost already recorded.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_FILE = /^prix-modeles-(\d{4}-\d{2}-\d{2})\.json$/;
const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/* Canonical unit price -> catalog field. All prices are USD. */
const PRICE_FIELDS = Object.freeze({
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
  cacheWrite1h: 'cache_creation_input_token_cost_above_1hr',
  audioInput: 'input_cost_per_audio_token',
  audioOutput: 'output_cost_per_audio_token',
  reasoning: 'output_cost_per_reasoning_token',
  image: 'output_cost_per_image',
  second: 'input_cost_per_second'
});
const PRICE_NAMES = Object.freeze(Object.keys(PRICE_FIELDS));

/* Canonical usage: DISJOINT counts — a token is counted in one field only. */
const USAGE_FIELDS = Object.freeze([
  'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h',
  'audioInput', 'audioOutput', 'reasoning', 'images', 'seconds'
]);

/* What each usage field is priced at, then its fallbacks (LiteLLM behaviour:
   a model without a cache price bills cached tokens as plain input). */
const PRICING_RULES = Object.freeze({
  input: ['input'],
  output: ['output'],
  cacheRead: ['cacheRead', 'input'],
  cacheWrite: ['cacheWrite', 'input'],
  cacheWrite1h: ['cacheWrite1h', 'cacheWrite', 'input'],
  audioInput: ['audioInput', 'input'],
  audioOutput: ['audioOutput', 'output'],
  reasoning: ['reasoning', 'output'],
  images: ['image'],
  seconds: ['second']
});

const CAPABILITY_FIELDS = Object.freeze({
  vision: 'supports_vision',
  tools: 'supports_function_calling',
  toolChoice: 'supports_tool_choice',
  audioInput: 'supports_audio_input',
  audioOutput: 'supports_audio_output',
  reasoning: 'supports_reasoning',
  promptCaching: 'supports_prompt_caching',
  responseSchema: 'supports_response_schema',
  pdfInput: 'supports_pdf_input',
  webSearch: 'supports_web_search'
});

/* Names callers use for a provider -> LiteLLM's provider prefix. */
const PROVIDER_ALIASES = Object.freeze({
  google: 'gemini',
  'google-ai': 'gemini',
  vertex: 'vertex_ai',
  together: 'together_ai',
  fireworks: 'fireworks_ai',
  vercel: 'vercel_ai_gateway',
  'vercel-ai-gateway': 'vercel_ai_gateway',
  gateway: 'vercel_ai_gateway',
  'workers-ai': 'cloudflare',
  'cloudflare-workers-ai': 'cloudflare',
  mistralai: 'mistral',
  'x-ai': 'xai'
});

const BILLINGS = Object.freeze(['paid', 'free', 'free_tier', 'credits']);
const COST_CODES = Object.freeze(['unknown_model', 'invalid_usage', 'no_price']);

const LONG_CONTEXT = /^(.+)_above_(\d+)k_tokens$/;

/* ---- bundled catalog --------------------------------------------------- */

/** Newest dated catalog file in `dir`: `{ file, date }`, or null. */
function bundledCatalogFile(dir = DATA_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_error) {
    return null;
  }
  const dated = names.filter((name) => CATALOG_FILE.test(name)).sort();
  if (dated.length === 0) return null;
  const name = dated[dated.length - 1];
  return { file: path.join(dir, name), date: CATALOG_FILE.exec(name)[1] };
}

let bundled = null;

/** The bundled catalog, parsed once: `{ data, date, file }`. */
function loadBundledCatalog() {
  if (bundled) return bundled;
  const found = bundledCatalogFile();
  if (!found) throw new Error('No dated price catalog in data/');
  bundled = { data: JSON.parse(fs.readFileSync(found.file, 'utf8')), date: found.date, file: found.file };
  return bundled;
}

/* ---- helpers ------------------------------------------------------------ */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrice = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const lower = (value) => value.toLowerCase();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/* Langfuse-style patterns: a RegExp, or a string with an optional (?i) prefix. */
function toRegExp(match, where) {
  if (match instanceof RegExp) return new RegExp(match.source, match.flags.replace(/[gy]/g, ''));
  if (typeof match === 'string' && match.length > 0) {
    const insensitive = match.startsWith('(?i)');
    return new RegExp(insensitive ? match.slice(4) : match, insensitive ? 'i' : '');
  }
  throw new TypeError(`${where}: "match" must be a RegExp or a non-empty string`);
}

/* Rounds float noise away (1e-12 USD) without hiding a real amount. */
const roundUsd = (value) => Math.round(value * 1e12) / 1e12;

/* ---- catalog entries -> canonical prices -------------------------------- */

function pricesFromEntry(entry) {
  const prices = {};
  for (const name of PRICE_NAMES) {
    if (isPrice(entry[PRICE_FIELDS[name]])) prices[name] = entry[PRICE_FIELDS[name]];
  }
  return prices;
}

/* Long-context surcharges (`*_above_200k_tokens`) and `tiered_pricing`
   ranges, as tiers keyed on the request's prompt size. */
function tiersFromEntry(entry) {
  const byThreshold = new Map();
  for (const [field, value] of Object.entries(entry)) {
    const long = LONG_CONTEXT.exec(field);
    if (!long || !isPrice(value)) continue;
    const name = PRICE_NAMES.find((candidate) => PRICE_FIELDS[candidate] === long[1]);
    if (!name) continue;
    const above = Number(long[2]) * 1000;
    if (!byThreshold.has(above)) byThreshold.set(above, {});
    byThreshold.get(above)[name] = value;
  }
  const tiers = [...byThreshold.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([above, prices]) => ({ name: `above_${above / 1000}k_tokens`, above, prices }));

  if (Array.isArray(entry.tiered_pricing)) {
    for (const tier of entry.tiered_pricing) {
      if (!tier || !Array.isArray(tier.range) || tier.range.length !== 2) continue;
      const prices = pricesFromEntry(tier);
      if (Object.keys(prices).length === 0) continue;
      tiers.push({ name: `range_${tier.range[0]}_${tier.range[1]}`, range: [tier.range[0], tier.range[1]], prices });
    }
  }
  return tiers;
}

function capabilitiesFromEntry(entry) {
  const capabilities = {};
  for (const [name, field] of Object.entries(CAPABILITY_FIELDS)) capabilities[name] = entry[field] === true;
  return capabilities;
}

const toLimit = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function contextFromEntry(entry) {
  return {
    maxInput: toLimit(entry.max_input_tokens) ?? toLimit(entry.max_tokens),
    maxOutput: toLimit(entry.max_output_tokens) ?? toLimit(entry.max_tokens)
  };
}

/* ---- overrides ---------------------------------------------------------- */

function normalizePriceMap(map, scale, where) {
  const prices = {};
  if (map === undefined) return prices;
  if (!isPlainObject(map)) throw new TypeError(`${where} must be an object`);
  for (const [name, value] of Object.entries(map)) {
    if (!PRICE_NAMES.includes(name)) throw new TypeError(`${where}: unknown price "${name}" (${PRICE_NAMES.join(', ')})`);
    if (!isPrice(value)) throw new TypeError(`${where}.${name} must be a number >= 0`);
    prices[name] = value * scale;
  }
  return prices;
}

function normalizeOverride(raw, where) {
  if (!isPlainObject(raw)) throw new TypeError(`${where} must be an object`);
  const override = { where };
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model.trim()) throw new TypeError(`${where}.model must be a non-empty string`);
    override.model = lower(raw.model.trim());
  }
  if (raw.match !== undefined) override.match = toRegExp(raw.match, where);
  if (override.model === undefined && override.match === undefined) throw new TypeError(`${where} needs "model" or "match"`);
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !raw.as.trim()) throw new TypeError(`${where}.as must be a catalog id`);
    override.as = raw.as.trim();
  }
  override.prices = {
    ...normalizePriceMap(raw.pricesPerMillion, 1e-6, `${where}.pricesPerMillion`),
    ...normalizePriceMap(raw.prices, 1, `${where}.prices`)
  };
  if (raw.discount !== undefined) {
    if (typeof raw.discount !== 'number' || !(raw.discount >= 0 && raw.discount <= 1)) {
      throw new TypeError(`${where}.discount must be a fraction between 0 and 1`);
    }
    override.discount = raw.discount;
  }
  const billing = raw.billing === undefined ? 'paid' : raw.billing;
  if (!BILLINGS.includes(billing)) throw new TypeError(`${where}.billing must be one of ${BILLINGS.join(', ')}`);
  override.billing = billing;
  if (billing === 'credits') {
    if (typeof raw.creditPool !== 'string' || !raw.creditPool) throw new TypeError(`${where}.creditPool is required with billing "credits"`);
    override.creditPool = raw.creditPool;
  }
  if (raw.contextWindow !== undefined) {
    if (!isPlainObject(raw.contextWindow)) throw new TypeError(`${where}.contextWindow must be an object`);
    override.contextWindow = { maxInput: toLimit(raw.contextWindow.maxInput), maxOutput: toLimit(raw.contextWindow.maxOutput) };
  }
  if (raw.capabilities !== undefined) {
    if (!isPlainObject(raw.capabilities)) throw new TypeError(`${where}.capabilities must be an object`);
    override.capabilities = {};
    for (const [name, value] of Object.entries(raw.capabilities)) {
      if (!(name in CAPABILITY_FIELDS) || typeof value !== 'boolean') {
        throw new TypeError(`${where}.capabilities.${name}: unknown capability or not a boolean`);
      }
      override.capabilities[name] = value;
    }
  }
  if (raw.provider !== undefined) override.provider = String(raw.provider);
  if (raw.mode !== undefined) override.mode = String(raw.mode);
  if (raw.note !== undefined) override.note = String(raw.note);
  return override;
}

function normalizeOverrides(overrides) {
  if (overrides === undefined || overrides === null) return [];
  if (Array.isArray(overrides)) return overrides.map((raw, i) => normalizeOverride(raw, `overrides[${i}]`));
  if (!isPlainObject(overrides)) throw new TypeError('overrides must be an object or an array');
  return Object.entries(overrides).map(([model, raw]) => normalizeOverride({ ...raw, model }, `overrides["${model}"]`));
}

function normalizeAliases(aliases) {
  const exact = new Map();
  const patterns = [];
  if (aliases === undefined || aliases === null) return { exact, patterns };
  const list = Array.isArray(aliases)
    ? aliases
    : isPlainObject(aliases)
      ? Object.entries(aliases).map(([from, model]) => ({ from, model }))
      : null;
  if (!list) throw new TypeError('aliases must be an object or an array');
  list.forEach((alias, i) => {
    const where = `aliases[${i}]`;
    if (!isPlainObject(alias) || typeof alias.model !== 'string' || !alias.model.trim()) {
      throw new TypeError(`${where}.model must be a catalog id`);
    }
    if (alias.from !== undefined) exact.set(lower(String(alias.from).trim()), alias.model.trim());
    else patterns.push({ match: toRegExp(alias.match, where), model: alias.model.trim() });
  });
  return { exact, patterns };
}

/* ---- usage -------------------------------------------------------------- */

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/* Vendor usage shapes -> canonical disjoint counts. Returns null when the
   shape is not recognised. */
function normalizeUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);

  // OpenAI chat completions: prompt_tokens INCLUDES cached and audio tokens,
  // completion_tokens INCLUDES reasoning and audio tokens.
  if (has('prompt_tokens') || has('completion_tokens')) {
    const promptDetails = raw.prompt_tokens_details || {};
    const completionDetails = raw.completion_tokens_details || {};
    const cacheRead = count(promptDetails.cached_tokens);
    const audioInput = count(promptDetails.audio_tokens);
    const reasoning = count(completionDetails.reasoning_tokens);
    const audioOutput = count(completionDetails.audio_tokens);
    return finishUsage({
      input: Math.max(0, count(raw.prompt_tokens) - cacheRead - audioInput),
      output: Math.max(0, count(raw.completion_tokens) - reasoning - audioOutput),
      cacheRead, audioInput, reasoning, audioOutput
    });
  }

  // Gemini usageMetadata: promptTokenCount INCLUDES cached tokens;
  // thoughtsTokenCount is separate from candidatesTokenCount.
  if (has('promptTokenCount') || has('candidatesTokenCount')) {
    const cacheRead = count(raw.cachedContentTokenCount);
    return finishUsage({
      input: Math.max(0, count(raw.promptTokenCount) - cacheRead),
      output: count(raw.candidatesTokenCount),
      reasoning: count(raw.thoughtsTokenCount),
      cacheRead
    });
  }

  // Anthropic (cache fields are separate from input_tokens), or the OpenAI
  // Responses API (input_tokens INCLUDES input_tokens_details.cached_tokens).
  if (has('input_tokens') || has('output_tokens')) {
    if (isPlainObject(raw.input_tokens_details) || isPlainObject(raw.output_tokens_details)) {
      const cacheRead = count((raw.input_tokens_details || {}).cached_tokens);
      const reasoning = count((raw.output_tokens_details || {}).reasoning_tokens);
      return finishUsage({
        input: Math.max(0, count(raw.input_tokens) - cacheRead),
        output: Math.max(0, count(raw.output_tokens) - reasoning),
        cacheRead, reasoning
      });
    }
    const creation = raw.cache_creation;
    const write1h = isPlainObject(creation) ? count(creation.ephemeral_1h_input_tokens) : 0;
    const writeTotal = count(raw.cache_creation_input_tokens);
    return finishUsage({
      input: count(raw.input_tokens),
      output: count(raw.output_tokens),
      cacheRead: count(raw.cache_read_input_tokens),
      cacheWrite: Math.max(0, writeTotal - write1h),
      cacheWrite1h: write1h
    });
  }

  // AI SDK (v5+): inputTokens INCLUDES cachedInputTokens, outputTokens
  // INCLUDES reasoningTokens.
  if (has('inputTokens') || has('outputTokens')) {
    const cacheRead = count(raw.cachedInputTokens);
    const reasoning = count(raw.reasoningTokens);
    return finishUsage({
      input: Math.max(0, count(raw.inputTokens) - cacheRead),
      output: Math.max(0, count(raw.outputTokens) - reasoning),
      cacheRead, reasoning
    });
  }

  // Canonical disjoint counts.
  const keys = Object.keys(raw);
  if (keys.length > 0 && keys.every((key) => USAGE_FIELDS.includes(key))) {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
    }
    return finishUsage(raw);
  }
  return null;
}

function finishUsage(partial) {
  const usage = {};
  for (const field of USAGE_FIELDS) usage[field] = count(partial[field]);
  return usage;
}

const promptSize = (usage) => usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h + usage.audioInput;

function pickTier(tiers, usage) {
  const size = promptSize(usage);
  let chosen = null;
  for (const tier of tiers) {
    if (tier.range) {
      const [min, max] = tier.range;
      if (size >= min && size < max) return tier;
    } else if (size > tier.above) {
      chosen = tier; // ascending: the highest threshold passed wins
    }
  }
  if (chosen) return chosen;
  // A prompt past the last range is billed at the last range.
  const ranges = tiers.filter((tier) => tier.range);
  if (ranges.length > 0 && size >= ranges[ranges.length - 1].range[1]) return ranges[ranges.length - 1];
  return null;
}

/* Pure: canonical usage x unit prices -> amounts. Missing price for a used
   field -> { ok: false, missing }. */
function priceUsage(usage, prices) {
  const breakdown = {};
  const used = {};
  const missing = [];
  let total = 0;
  for (const field of USAGE_FIELDS) {
    const quantity = usage[field];
    if (quantity === 0) continue;
    const priceName = PRICING_RULES[field].find((name) => isPrice(prices[name]));
    if (priceName === undefined) {
      missing.push(field);
      continue;
    }
    const amount = quantity * prices[priceName];
    breakdown[field] = roundUsd(amount);
    used[field] = { price: priceName, perUnit: prices[priceName] };
    total += amount;
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, total: roundUsd(total), breakdown, used };
}

/* ---- the catalog -------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {object} [options.data]       LiteLLM-format catalog (default: the bundled dated copy)
 * @param {string} [options.date]       Its date (default: the bundled file's date, else null)
 * @param {object|Array} [options.overrides] Local prices, free models, free tiers, credit pools — they win
 * @param {object|Array} [options.aliases]   { 'my-name': 'catalog-id' } or [{ match, model }]
 * @param {() => number} [options.now]  Clock for `computedAt`
 */
function createPriceCatalog(options = {}) {
  let data = options.data;
  let date = options.date === undefined ? null : options.date;
  if (data === undefined) {
    const loaded = loadBundledCatalog();
    data = loaded.data;
    if (options.date === undefined) date = loaded.date;
  }
  if (!isPlainObject(data)) throw new TypeError('data must be a LiteLLM-format catalog object');
  const now = options.now || Date.now;
  const overrides = normalizeOverrides(options.overrides);
  const aliases = normalizeAliases(options.aliases);

  // Case-insensitive index, built once. The spec sample is not a model.
  const index = new Map();
  const providers = new Set();
  for (const [key, entry] of Object.entries(data)) {
    if (key === 'sample_spec' || !isPlainObject(entry)) continue;
    if (!index.has(lower(key))) index.set(lower(key), key);
    if (typeof entry.litellm_provider === 'string') providers.add(lower(entry.litellm_provider));
    const slash = key.indexOf('/');
    if (slash > 0) providers.add(lower(key.slice(0, slash)));
  }

  const canonicalProvider = (name) => {
    const value = lower(name);
    return PROVIDER_ALIASES[value] || value;
  };
  const exact = (id) => index.get(lower(id)) || null;

  const providerMatches = (key, wanted) => {
    const owner = lower(String(data[key].litellm_provider || ''));
    return owner === wanted || owner.startsWith(`${wanted}-`) || lower(key).startsWith(`${wanted}/`);
  };

  /* Catalog key for an id: exact, alias, provider prefix, unique suffix
     within the provider. `{ key, matchedBy }` or null. A provider (the
     `provider` option first, else the id's own prefix) is never answered
     with another provider's entry: Groq's "openai/gpt-oss-120b" is not
     OpenAI's price. */
  function resolveKey(id, provider, seen = new Set()) {
    if (seen.has(lower(id))) return null;
    seen.add(lower(id));

    const scope = provider ? canonicalProvider(provider) : null;
    if (scope) {
      const scoped = exact(`${scope}/${id}`);
      if (scoped) return { key: scoped, matchedBy: 'provider_prefix' };
    }

    let head = null;
    let rest = id;
    const slash = id.indexOf('/');
    if (slash > 0 && providers.has(canonicalProvider(id.slice(0, slash)))) {
      head = canonicalProvider(id.slice(0, slash));
      rest = id.slice(slash + 1);
    }
    const wanted = scope || head;

    const direct = exact(id);
    if (direct && (!scope || providerMatches(direct, scope))) return { key: direct, matchedBy: 'exact' };

    const aliased = aliases.exact.get(lower(id))
      || (aliases.patterns.find((alias) => alias.match.test(id)) || {}).model;
    if (aliased) {
      const found = resolveKey(aliased, provider, seen);
      if (found) return { key: found.key, matchedBy: 'alias' };
    }
    if (!wanted) return null;
    if (scope && head !== scope) rest = id; // the prefix belongs to the model name

    const prefixed = exact(`${wanted}/${rest}`);
    if (prefixed) return { key: prefixed, matchedBy: 'provider_prefix' };

    // "openai/gpt-4o" -> "gpt-4o" when the bare entry belongs to that provider.
    const bare = rest !== id ? exact(rest) : null;
    if (bare && providerMatches(bare, wanted)) return { key: bare, matchedBy: 'provider_prefix' };

    // "groq" + "gpt-oss-120b" -> "groq/openai/gpt-oss-120b" when unique.
    const suffix = `/${lower(rest)}`;
    const matches = [];
    for (const [lowKey, key] of index) {
      if (lowKey.endsWith(suffix) && providerMatches(key, wanted)) matches.push(key);
    }
    if (matches.length === 1) return { key: matches[0], matchedBy: 'provider_suffix' };
    return null;
  }

  function findOverride(id, key) {
    const ids = [lower(id)];
    if (key) ids.push(lower(key));
    return overrides.find((override) => (
      (override.model !== undefined && ids.includes(override.model))
      || (override.match !== undefined && (override.match.test(id) || (key !== null && override.match.test(key))))
    )) || null;
  }

  /** Everything known about a model, or `{ ok: false, code: 'unknown_model' }`. */
  function lookup(model, lookupOptions = {}) {
    if (typeof model !== 'string' || !model.trim()) {
      return { ok: false, code: 'unknown_model', model: String(model), message: 'model must be a non-empty string' };
    }
    const id = model.trim().replace(/^models\//i, '');
    let resolved = resolveKey(id, lookupOptions.provider);
    let override = findOverride(id, resolved ? resolved.key : null);
    if (override && override.as) {
      const borrowed = resolveKey(override.as, lookupOptions.provider);
      if (!borrowed) {
        return { ok: false, code: 'unknown_model', model, message: `${override.where}.as "${override.as}" is not in the catalog` };
      }
      resolved = { key: borrowed.key, matchedBy: 'override' };
    }
    if (!resolved && !override) {
      return { ok: false, code: 'unknown_model', model, message: 'not in the price catalog and no local override matches' };
    }

    const entry = resolved ? data[resolved.key] : {};
    const listPrices = pricesFromEntry(entry);
    const tiers = tiersFromEntry(entry);
    let prices = { ...listPrices };
    if (override) {
      prices = { ...prices, ...override.prices };
      if (override.discount !== undefined) {
        for (const name of Object.keys(prices)) {
          if (!(name in override.prices)) prices[name] *= 1 - override.discount;
        }
        for (const tier of tiers) {
          for (const name of Object.keys(tier.prices)) tier.prices[name] *= 1 - override.discount;
        }
      }
      // A locally priced field is never surcharged by a catalog tier.
      for (const tier of tiers) {
        for (const name of Object.keys(override.prices)) delete tier.prices[name];
      }
    }
    const info = {
      ok: true,
      model,
      key: resolved ? resolved.key : id,
      provider: (override && override.provider) || (entry.litellm_provider ?? null),
      mode: (override && override.mode) || (entry.mode ?? null),
      matchedBy: resolved ? resolved.matchedBy : 'override',
      source: resolved && override ? 'catalog+override' : resolved ? 'catalog' : 'override',
      billing: override ? override.billing : 'paid',
      prices,
      listPrices,
      tiers: tiers.filter((tier) => Object.keys(tier.prices).length > 0),
      contextWindow: { ...contextFromEntry(entry), ...(override && override.contextWindow ? override.contextWindow : {}) },
      capabilities: { ...capabilitiesFromEntry(entry), ...(override && override.capabilities ? override.capabilities : {}) },
      deprecationDate: typeof entry.deprecation_date === 'string' ? entry.deprecation_date : null,
      catalogDate: date
    };
    if (override && override.creditPool) info.creditPool = override.creditPool;
    if (override && override.note) info.note = override.note;
    return deepFreeze(info);
  }

  /**
   * Cost of one call. `usage`: canonical disjoint counts, or the usage object
   * of OpenAI, Anthropic, Gemini or the AI SDK. The result is frozen and
   * self-contained (unit prices, catalog date, time of computation).
   */
  function cost(model, usage, costOptions = {}) {
    const info = lookup(model, costOptions);
    if (!info.ok) return info;
    const counts = normalizeUsage(usage);
    if (!counts) {
      return deepFreeze({ ok: false, code: 'invalid_usage', model, message: 'usage is not a recognised token count object' });
    }

    const tier = pickTier(info.tiers, counts);
    const prices = tier ? { ...info.prices, ...tier.prices } : { ...info.prices };
    const listTier = pickTier(info.source === 'override' ? [] : tiersFromEntry(data[info.key]), counts);
    const listPrices = listTier ? { ...info.listPrices, ...listTier.prices } : { ...info.listPrices };

    let billing = info.billing;
    if (billing === 'free_tier' && costOptions.freeTierExhausted === true) billing = 'paid';

    const priced = priceUsage(counts, prices);
    const listed = priceUsage(counts, listPrices);
    const free = billing === 'free' || billing === 'free_tier';
    if (!priced.ok && !free) {
      return deepFreeze({
        ok: false,
        code: 'no_price',
        model,
        key: info.key,
        missing: priced.missing,
        message: `no price for ${priced.missing.join(', ')}`
      });
    }

    const result = {
      ok: true,
      model,
      key: info.key,
      provider: info.provider,
      matchedBy: info.matchedBy,
      source: info.source,
      currency: 'USD',
      billing,
      total: free ? 0 : priced.total,
      // What the catalog says the call is worth, whatever is billed: lets a
      // free tier or a credit pool be watched in real money. Null if unknown.
      listTotal: listed.ok ? listed.total : null,
      breakdown: free ? {} : priced.breakdown,
      unitPrices: priced.ok ? priced.used : {},
      tier: tier ? tier.name : null,
      usage: counts,
      catalogDate: info.catalogDate,
      computedAt: new Date(now()).toISOString()
    };
    if (info.creditPool) result.creditPool = info.creditPool;
    return deepFreeze(result);
  }

  function contextWindow(model, lookupOptions) {
    const info = lookup(model, lookupOptions);
    return info.ok ? deepFreeze({ ok: true, model, key: info.key, ...info.contextWindow }) : info;
  }

  function capabilities(model, lookupOptions) {
    const info = lookup(model, lookupOptions);
    return info.ok ? deepFreeze({ ok: true, model, key: info.key, ...info.capabilities }) : info;
  }

  return Object.freeze({
    lookup,
    cost,
    contextWindow,
    capabilities,
    date,
    size: index.size
  });
}

/* ---- catalog diff (update script) ------------------------------------- */

const trackedField = (field) => /cost|^max_(input_|output_)?tokens$/.test(field);

/** Models added, removed, and price/context fields changed between two catalogs. */
function diffPriceCatalogs(before, after) {
  const keysOf = (catalog) => new Set(Object.keys(catalog).filter((key) => key !== 'sample_spec'));
  const old = keysOf(before);
  const next = keysOf(after);
  const added = [...next].filter((key) => !old.has(key)).sort();
  const removed = [...old].filter((key) => !next.has(key)).sort();
  const changed = [];
  for (const key of [...next].filter((k) => old.has(k)).sort()) {
    const a = before[key] || {};
    const b = after[key] || {};
    const fields = new Set([...Object.keys(a), ...Object.keys(b)].filter(trackedField));
    for (const field of [...fields].sort()) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        changed.push({ key, field, before: a[field] ?? null, after: b[field] ?? null });
      }
    }
  }
  return { added, removed, changed };
}

module.exports = {
  createPriceCatalog,
  loadBundledCatalog,
  bundledCatalogFile,
  normalizeUsage,
  diffPriceCatalogs,
  PRICE_NAMES,
  USAGE_FIELDS,
  BILLINGS,
  COST_CODES,
  PROVIDER_ALIASES,
  CATALOG_URL
};
