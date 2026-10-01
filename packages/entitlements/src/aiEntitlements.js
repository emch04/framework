/* global structuredClone */
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);

/** Store RAM de développement. En production, les opérations de réservation
 * doivent être atomiques et partagées entre toutes les instances. */
function createMemoryAIEntitlementsStore() {
  const keys = new Map();
  const usage = new Map();
  const reservations = new Map();
  return {
    async createKey(row) { if (keys.has(row.id) || [...keys.values()].some((k) => k.fingerprint === row.fingerprint)) throw new Error('Clé déjà existante.'); keys.set(row.id, copy(row)); return copy(row); },
    async findKeyByFingerprint(fingerprint) { const row = [...keys.values()].find((k) => k.fingerprint === fingerprint); return row ? copy(row) : null; },
    async findKey(id) { const row = keys.get(id); return row ? copy(row) : null; },
    async revokeKey(id, at) { const row = keys.get(id); if (!row || row.revokedAt) return false; row.revokedAt = at; return true; },
    async getUsage(keyId, window) { return copy(usage.get(`${keyId}:${window}`) || { requests: 0, tokens: 0, cost: 0, providerCosts: {} }); },
    async getProviderCosts(keyId) { const totals = {}; for (const [key, row] of usage) if (key.startsWith(`${keyId}:`)) for (const [provider, cost] of Object.entries(row.providerCosts || {})) totals[provider] = (totals[provider] || 0) + cost; return totals; },
    async reserve({ id, keyId, windows, amount, limits = {}, quotas = {}, estimatedTokens = 0 }) { if (reservations.has(id)) throw new Error('Réservation déjà existante.'); for (const window of windows) { const k = `${keyId}:${window}`; const u = usage.get(k) || { requests: 0, tokens: 0, cost: 0 }; const budgetPeriod = window.startsWith('day:') ? 'daily' : 'monthly'; const budgetLimit = limits[budgetPeriod]; if ((window.startsWith('day:') || window.startsWith('month:')) && budgetLimit != null && u.cost + amount > budgetLimit) { const error = new Error('Budget dépassé.'); error.code = 'AI_BUDGET'; throw error; } const quotaName = window.startsWith('minute:') ? 'requestsPerMinute' : window.startsWith('day:') ? 'requestsPerDay' : null; if (quotaName && quotas[quotaName] != null && u.requests >= quotas[quotaName]) { const error = new Error('Quota de requêtes dépassé.'); error.code = 'AI_QUOTA'; error.quota = quotaName; throw error; } if (window.startsWith('minute:') && quotas.tokensPerMinute != null && u.tokens + estimatedTokens > quotas.tokensPerMinute) { const error = new Error('Quota de jetons dépassé.'); error.code = 'AI_QUOTA'; error.quota = 'tokensPerMinute'; throw error; } } reservations.set(id, { keyId, windows, amount, estimatedTokens, settled: false }); for (const window of windows) { const k = `${keyId}:${window}`; const u = usage.get(k) || { requests: 0, tokens: 0, cost: 0 }; u.cost += amount; u.requests++; if (window.startsWith('minute:')) u.tokens += estimatedTokens; usage.set(k, u); } },
    async settle(id, actual, tokens = 0, provider = null) { const row = reservations.get(id); if (!row || row.settled) throw new Error('Réservation inconnue ou déjà réglée.'); for (const window of row.windows) { const u = usage.get(`${row.keyId}:${window}`); u.cost += actual - row.amount; if (window.startsWith('minute:')) u.tokens += tokens - row.estimatedTokens; if (provider && window.startsWith('month:')) { u.providerCosts = u.providerCosts || {}; u.providerCosts[provider] = (u.providerCosts[provider] || 0) + actual; } } row.settled = true; },
    async recordRequest(keyId, window, tokens) { const k = `${keyId}:${window}`; const u = usage.get(k) || { requests: 0, tokens: 0, cost: 0 }; u.requests++; u.tokens += tokens; usage.set(k, u); }
  };
}

/** Droits IA calculés à chaque appel depuis le plan courant du compte. */
function createAIEntitlements(options = {}) {
  const { catalog, resolveAccount } = options;
  if (!catalog || typeof catalog.featuresOf !== 'function') throw new Error('createAIEntitlements exige un catalogue de plans.');
  if (typeof resolveAccount !== 'function') throw new Error('createAIEntitlements exige resolveAccount.');
  const store = options.store || createMemoryAIEntitlementsStore();
  const now = options.now || Date.now;
  const plans = options.plans || {};
  const random = options.randomBytes || randomBytes;
  const time = () => new Date(now());
  const windows = () => {
    const d = time(); const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const minute = Math.floor(d.getTime() / 60000);
    return { minute: String(minute), day: day.toISOString().slice(0, 10), month: month.toISOString().slice(0, 7), dayStart: day.getTime(), monthStart: month.getTime() };
  };
  const eligible = (key, rights, model) => {
    const group = Object.entries(rights.groups || {}).find(([, members]) => members.includes(model))?.[0];
    if (!group || !(rights.allowedGroups || []).includes(group)) return { ok: false, reason: 'model_not_allowed' };
    if (key.restrictions?.groups && !key.restrictions.groups.includes(group)) return { ok: false, reason: 'model_not_allowed' };
    return { ok: true, group };
  };
  async function resolveKey(token) {
    if (typeof token !== 'string' || !token) return null;
    const fingerprint = digest(token); const row = await store.findKeyByFingerprint(fingerprint);
    const expected = row?.fingerprint || '0'.repeat(64);
    const a = Buffer.from(fingerprint, 'hex'); const b = Buffer.from(expected, 'hex');
    const matches = timingSafeEqual(a, b);
    return matches && row && !row.revokedAt ? row : null;
  }
  async function rightsFor(key) {
    const account = await resolveAccount(key.accountId);
    if (!account) return null;
    const raw = plans[account.plan] || plans[catalog.fallbackPlan] || {};
    const featurePlan = catalog.featuresOf(account.plan).filter((feature) => !key.restrictions?.features || key.restrictions.features.includes(feature));
    const allowedGroups = (raw.allowedGroups || []).filter((group) => !key.restrictions?.groups || key.restrictions.groups.includes(group));
    const quotas = { ...(raw.quotas || {}) };
    for (const [name, limit] of Object.entries(key.restrictions?.quotas || {})) quotas[name] = quotas[name] == null ? limit : Math.min(quotas[name], limit);
    const budgets = { ...(raw.budgets || {}) };
    for (const [name, limit] of Object.entries(key.restrictions?.budgets || {})) budgets[name] = budgets[name] == null ? limit : Math.min(budgets[name], limit);
    const aliases = Object.fromEntries(Object.entries(raw.aliases || {}).filter(([alias, target]) => !key.restrictions?.aliases || key.restrictions.aliases[alias] === target));
    return {
      plan: account.plan, groups: copy(raw.groups || {}), allowedGroups,
      aliases: copy(aliases), features: featurePlan, quotas, budgets
    };
  }
  async function authorize(key, rights, model, estimatedCost, estimatedTokens = 0) {
    const access = eligible(key, rights, model); if (!access.ok) return access;
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) throw new Error('Le coût estimé doit être positif ou nul.');
    const w = windows(); const quota = rights.quotas;
    for (const [period, label] of [['minute', 'requestsPerMinute'], ['day', 'requestsPerDay']]) {
      const limit = quota[label]; if (limit == null) continue;
      const u = await store.getUsage(key.id, `${period}:${w[period]}`); if (u.requests >= limit) return { ok: false, reason: 'quota', quota: label };
    }
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) throw new Error('Le nombre de jetons estimé doit être positif ou nul.');
    if (quota.tokensPerMinute != null && (await store.getUsage(key.id, `minute:${w.minute}`)).tokens + estimatedTokens > quota.tokensPerMinute) return { ok: false, reason: 'quota', quota: 'tokensPerMinute' };
    for (const [period, label] of [['day', 'daily'], ['month', 'monthly']]) {
      const budget = rights.budgets[label]; if (budget == null) continue;
      const u = await store.getUsage(key.id, `${period}:${w[period]}`); if (u.cost + estimatedCost > budget) return { ok: false, reason: 'budget', budget: label };
    }
    return { ok: true, group: access.group, window: w };
  }
  async function issueKey(accountId, restrictions = {}) {
    if (accountId == null) throw new Error('Un compte est requis.');
    const id = random(12).toString('hex'); const secret = random(32).toString('base64url'); const token = `ak_${id}_${secret}`;
    const row = { id, accountId, fingerprint: digest(token), restrictions: copy(restrictions), createdAt: time().toISOString(), revokedAt: null };
    await store.createKey(row); return { id, token, prefix: `ak_${id.slice(0, 8)}` };
  }
  async function resolve(token) {
    const key = await resolveKey(token); if (!key) return null;
    const rights = await rightsFor(key); if (!rights) return null;
    return { plan: rights.plan, groups: rights.allowedGroups, aliases: rights.aliases, features: rights.features, quotas: rights.quotas, budgets: rights.budgets };
  }
  async function decide(token, model, estimatedCost = 0, estimatedTokens = 0) {
    const key = await resolveKey(token); if (!key) return { allowed: false, reason: 'invalid_key' };
    const rights = await rightsFor(key); if (!rights) return { allowed: false, reason: 'account_not_found' };
    const target = rights.aliases[model] || model;
    const check = await authorize(key, rights, target, estimatedCost, estimatedTokens);
    return check.ok ? { allowed: true, model: target, group: check.group, plan: rights.plan } : { allowed: false, reason: check.reason, ...(check.quota ? { quota: check.quota } : {}), ...(check.budget ? { budget: check.budget } : {}) };
  }
  async function execute(token, model, estimatedCost, fallback = [], invoke = async (target) => ({ model: target, cost: typeof estimatedCost === 'function' ? estimatedCost(target) : estimatedCost, tokens: 0 }), estimatedTokens = 0) {
    const key = await resolveKey(token); if (!key) return { allowed: false, reason: 'invalid_key' };
    const reservationId = () => random(16).toString('hex');
    let lastDenial = null;
    for (const requested of [model, ...fallback]) {
      const rights = await rightsFor(key); if (!rights) return { allowed: false, reason: 'account_not_found' };
      const target = rights.aliases[requested] || requested;
      const targetEstimate = typeof estimatedCost === 'function' ? estimatedCost(target) : estimatedCost;
      const check = await authorize(key, rights, target, targetEstimate, estimatedTokens);
      if (!check.ok) { lastDenial = check; continue; }
      const rid = reservationId(); const reservationWindows = [`minute:${check.window.minute}`, `day:${check.window.day}`, `month:${check.window.month}`];
      try { await store.reserve({ id: rid, keyId: key.id, windows: reservationWindows, amount: targetEstimate, limits: rights.budgets, quotas: rights.quotas, estimatedTokens }); }
      catch (error) { if (error.code === 'AI_BUDGET' || error.code === 'AI_QUOTA') { lastDenial = { reason: error.code === 'AI_BUDGET' ? 'budget' : 'quota', ...(error.quota ? { quota: error.quota } : {}) }; continue; } throw error; }
      try {
        const result = await invoke(target);
        if (!result || !Number.isFinite(result.cost) || result.cost < 0) throw new Error('Le coût réel retourné est invalide.');
        await store.settle(rid, result.cost, result.tokens || 0, result.provider || null);
        return { allowed: true, requested: model, model: target, provider: result.provider, cost: result.cost, tokens: result.tokens || 0, result };
      } catch (error) { await store.settle(rid, 0, 0); if (requested === fallback[fallback.length - 1]) return { allowed: false, reason: 'call_failed', error }; }
    }
    return { allowed: false, reason: lastDenial?.reason || 'no_eligible_fallback', ...(lastDenial?.quota ? { quota: lastDenial.quota } : {}), ...(lastDenial?.budget ? { budget: lastDenial.budget } : {}) };
  }
  async function revoke(id) { return store.revokeKey(id, time().toISOString()); }
  return { issueKey, resolve, decide, execute, revoke };
}

module.exports = { createAIEntitlements, createMemoryAIEntitlementsStore };
