const { AppError } = require('@astratra/core');
const { randomUUID } = require('crypto');
const { createBreakerPool, isCircuitOpen } = require('./breakers');

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_COOLDOWN_JITTER_MS = 8 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_DEGRADED_MS = 5 * 60 * 1000;
const RPM_WINDOW_MS = 60 * 1000;
const RESERVE_USAGE_SCRIPT = `
local now = tonumber(ARGV[1])
local rpmLimit = tonumber(ARGV[2])
local rpdLimit = tonumber(ARGV[3])
local tpdLimit = tonumber(ARGV[4])
local tokenCost = tonumber(ARGV[5])
local reservationId = ARGV[6]
local rpmWindowMs = tonumber(ARGV[7])
local rpmTtl = tonumber(ARGV[8])
local dayTtl = tonumber(ARGV[9])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - rpmWindowMs)
if rpmLimit > 0 and redis.call('ZCARD', KEYS[1]) >= rpmLimit then return 0 end

local rpdUsed = tonumber(redis.call('GET', KEYS[2]) or '0')
if rpdLimit > 0 and rpdUsed + 1 > rpdLimit then return 0 end

local tpdUsed = tonumber(redis.call('GET', KEYS[3]) or '0')
if tpdLimit > 0 and tpdUsed + tokenCost > tpdLimit then return 0 end

redis.call('ZADD', KEYS[1], now, reservationId)
redis.call('EXPIRE', KEYS[1], rpmTtl)
redis.call('INCRBY', KEYS[2], 1)
redis.call('EXPIRE', KEYS[2], dayTtl)
redis.call('INCRBY', KEYS[3], tokenCost)
redis.call('EXPIRE', KEYS[3], dayTtl)
return 1
`;

function createProviderRouter(config = {}) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const state = createInitialState(providers);
  const options = {
    cooldownMs: config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    cooldownJitterMs: config.cooldownJitterMs ?? DEFAULT_COOLDOWN_JITTER_MS,
    maxFailures: config.maxFailures ?? DEFAULT_MAX_FAILURES,
    degradedMs: config.degradedMs ?? DEFAULT_DEGRADED_MS,
    intentRouting: config.intentRouting || {},
    redisKeyPrefix: config.redisKeyPrefix || 'astratra:ai:provider',
    /* Ce qui met un modèle au repos. Par défaut un 429 ; un projet peut y
       ajouter un 503 « surchargé » ou un délai dépassé. */
    cooldownOn: typeof config.cooldownOn === 'function' ? config.cooldownOn : isRateLimitError,
    /* 'try' : quand tous les candidats se reposent, on les essaie quand même —
       un repos est une supposition, pas un refus. */
    whenAllCooling: config.whenAllCooling === 'try' ? 'try' : 'skip',
    now: typeof config.now === 'function' ? config.now : Date.now
  };
  /* One circuit per PROVIDER, never one for all: a provider that is down must
     not take the others with it. Optional — the per-model cooldown and
     degradation below work without it. Resolved BEFORE any timer or
     connection starts: a wiring error must not leave a timer behind. */
  const breakers = resolveBreakers(config.breakers);
  let midnightTimer = null;
  const resetDailyAtMidnight = () => {
    resetDailyUsage(state);
    midnightTimer = unref(setTimeout(resetDailyAtMidnight, msUntilNextMidnight()));
  };
  /* Le minuteur ne garde jamais le processus en vie : un routeur créé au
     chargement d'un module ne doit pas empêcher un script ou des tests de finir. */
  midnightTimer = unref(setTimeout(resetDailyAtMidnight, msUntilNextMidnight()));

  const redis = createRedisLink(config, options);
  const redisReady = redis.connect().then(() => redis.restoreState(state)).catch(() => {});


  /**
   * Comme ask, mais dit aussi QUI a répondu : { value, provider, model, key, partial }.
   * `key` est la clé d'état ("fournisseur:modèle", suivie de "@voie" quand le
   * fournisseur a une voie pour cet appel).
   */
  async function route(prompt, request = {}, ctx = {}) {
    await redisReady;
    const signal = ctx && ctx.signal;
    const masker = ctx && ctx.masker && typeof ctx.masker.mask === 'function' ? ctx.masker : null;
    const providerCtx = masker ? withoutMasker(ctx) : ctx;
    const accepts = typeof request.accepts === 'function' ? request.accepts : null;
    const partial = typeof request.partial === 'function' ? request.partial : null;

    /* Un fournisseur sans clé (ou éteint) est sauté sans bruit : ni quota, ni échec. */
    const reachable = [];
    for (const candidate of selectCandidates(providers, options.intentRouting, request)) {
      if (typeof candidate.provider.available === 'function' && !(await candidate.provider.available(providerCtx))) continue;
      reachable.push(candidate);
    }
    if (!reachable.length) throw unavailable('AI_NO_PROVIDER', 'No AI provider is available for this request.');
    const matching = typeof request.select === 'function'
      ? reachable.filter(({ provider, model }) => request.select(model, provider))
      : reachable;
    if (!matching.length) throw unavailable('AI_NO_MATCH', 'No available AI model matches this request.');

    const keyed = matching.map((candidate) => ({ ...candidate, key: laneKey(candidate.provider, candidate.model, providerCtx) }));
    const awake = keyed.filter(({ key, model }) => isModelAvailable(state, key, model, request, options.now()));
    const tried = awake.length || options.whenAllCooling !== 'try' ? awake : keyed;

    const errors = [];
    let last = null;
    let kept = null;
    for (const { provider, model, key } of tried) {
      stopIfAborted(signal);
      const reservation = await redis.reserveUsage(key, model, request);
      if (!reservation) continue;

      const undo = reserveUsage(state, key, request, options.now());

      /* Masked at the moment it leaves: a provider that runs on this machine
         (`external: false`) gets the text as it is. */
      const outbound = masker && provider.external !== false;
      const send = async () => provider.call(outbound ? await masker.maskAsync(prompt) : prompt, providerCtx, model);

      let raw;
      try {
        raw = breakers ? await breakers.run(provider.id, send) : await send();
      } catch (error) {
        /* La personne est partie : rien n'a échoué, on s'arrête là. */
        stopIfAborted(signal);
        errors.push(error);
        last = `${key}: ${error && error.message}`;
        if (isCircuitOpen(error)) {
          /* The breaker refused before anything was sent: nothing was used,
             and the model itself did not fail. */
          undo();
          redis.releaseUsage(reservation);
          continue;
        }
        markFailure(state, key, error, options);
        redis.mirrorFailure(key, state.models[key]);
        continue;
      }
      clearFailures(state, key);
      redis.mirrorFailures(key, state.models[key]);
      const value = outbound ? unmaskResult(masker, raw) : raw;
      /* Une réponse coupée à sa longueur n'est pas donnée tant qu'un autre
         modèle peut la finir : gardée en dernier recours. */
      if (partial && partial(value) && (!accepts || accepts(value))) {
        kept = kept || { value, provider: provider.id, model: model.id, key, partial: true };
        last = `${key} stopped short`;
        continue;
      }
      if (accepts && !accepts(value)) {
        /* Une réponse que l'appelant refuse (outil inconnu, texte vide) passe
           au modèle suivant ; ce n'est pas une panne du modèle. */
        last = `${key} gave a response that was not accepted`;
        continue;
      }
      return { value, provider: provider.id, model: model.id, key, partial: false };
    }

    if (kept) return kept;
    const error = unavailable('AI_UNAVAILABLE', `No available AI provider/model for this request.${last ? ` Last error: ${last}` : ''}`);
    error.errors = errors;
    throw error;
  }

  async function ask(prompt, request = {}, ctx = {}) {
    return (await route(prompt, request, ctx)).value;
  }

  function getStats() {
    const now = options.now();
    const stats = {};
    const entry = (providerId, model, modelState) => ({
      provider: providerId,
      rpm_now: currentRpm(modelState, now),
      rpm_limit: model.rpm ?? null,
      rpd_used: modelState.rpdUsed,
      rpd_limit: model.rpd ?? null,
      tpd_used: modelState.tpdUsed,
      tpd_limit: model.tpd ?? null,
      cooldown: isUntilActive(modelState.cooldownUntil, now),
      degraded: isUntilActive(modelState.degradedUntil, now),
      failures: modelState.failures || 0,
      circuit: breakers ? breakers.stateOf(providerId) || 'closed' : null
    });
    providers.forEach(provider => {
      (provider.models || []).forEach(model => {
        const key = modelKey(provider, model);
        stats[key] = entry(provider.id, model, state.models[key] || createModelState());
      });
    });
    /* Les modèles demandés par `request.candidates` et les voies n'existent
       qu'une fois utilisés : ils apparaissent alors, sans limites déclarées. */
    Object.entries(state.models).forEach(([key, modelState]) => {
      if (!stats[key]) stats[key] = entry(key.split(':')[0], {}, modelState);
    });
    return stats;
  }

  /** Oublie repos, dégradations, échecs et usage (tests, remise à zéro manuelle). */
  function reset() {
    Object.keys(state.models).forEach((key) => { state.models[key] = createModelState(); });
  }

  function stop() {
    if (midnightTimer) {
      clearTimeout(midnightTimer);
      midnightTimer = null;
    }
    redis.disconnect();
  }

  return { ask, route, getStats, reset, stop, breakers };
}

/** A pool, a factory, or nothing. */
function resolveBreakers(value) {
  if (!value) return null;
  if (typeof value === 'function') return createBreakerPool({ create: value });
  if (typeof value.run === 'function' && typeof value.get === 'function') return value;
  throw new Error('createProviderRouter: breakers must be a factory (providerId) => breaker or a pool from createBreakerPool().');
}

/* The masker is the router's business; the provider never sees it. */
function withoutMasker(ctx) {
  const rest = { ...ctx };
  delete rest.masker;
  return rest;
}

function unmaskResult(masker, value) {
  if (value && typeof value[Symbol.asyncIterator] === 'function' && typeof masker.unmaskStream === 'function') {
    return masker.unmaskStream(value);
  }
  return typeof masker.unmaskDeep === 'function' ? masker.unmaskDeep(value) : value;
}

function createInitialState(providers) {
  const state = { models: {} };
  providers.forEach(provider => {
    (provider.models || []).forEach(model => {
      state.models[modelKey(provider, model)] = createModelState();
    });
  });
  return state;
}

function createModelState() {
  return {
    rpmWindow: [],
    rpdUsed: 0,
    tpdUsed: 0,
    cooldownUntil: 0,
    degradedUntil: 0,
    failures: 0
  };
}

// Redis makes quota reservations atomically across instances. If it is absent
// or unavailable, the router falls back to the process-local counters.
function createRedisLink(config, options) {
  const noop = {
    connect: async () => {},
    restoreState: async () => {},
    reserveUsage: async () => true,
    releaseUsage: () => {},
    mirrorFailure: () => {},
    mirrorFailures: () => {},
    disconnect: () => {}
  };

  if (!config.redisUrl) return noop;

  let client = null;
  const prefix = options.redisKeyPrefix;
  const dayKey = (type, key) => `${prefix}:${type}:${key}:${new Date().toISOString().slice(0, 10)}`;
  const stateKey = (type, key) => `${prefix}:${type}:${key}`;
  const secondsUntilMidnight = () => Math.ceil(msUntilNextMidnight() / 1000);

  async function connect() {
    let RedisModule;
    try {
      RedisModule = require('redis');
    } catch (_error) {
      return;
    }

    try {
      client = RedisModule.createClient({ url: config.redisUrl });
      client.on('error', () => {
        // Swallow: a Redis outage must never surface as an app-level error.
      });
      await client.connect();
    } catch (_error) {
      client = null;
    }
  }

  async function restoreState(state) {
    if (!client || !client.isOpen) return;
    try {
      for (const [key, modelState] of Object.entries(state.models)) {
        const [rpd, tpd, failures, cooldownTtl, degradedTtl] = await Promise.all([
          client.get(dayKey('rpd', key)),
          client.get(dayKey('tpd', key)),
          client.get(stateKey('failures', key)),
          client.ttl(stateKey('cooldown', key)),
          client.ttl(stateKey('degraded', key))
        ]);

        if (rpd) modelState.rpdUsed = parseInt(rpd, 10);
        if (tpd) modelState.tpdUsed = parseInt(tpd, 10);
        if (failures) modelState.failures = parseInt(failures, 10);
        if (cooldownTtl > 0) modelState.cooldownUntil = Date.now() + cooldownTtl * 1000;
        if (degradedTtl > 0) modelState.degradedUntil = Date.now() + degradedTtl * 1000;
      }
    } catch (_error) {
      // Partial or failed restore just means we start from RAM defaults.
    }
  }

  async function reserveUsage(key, model, request) {
    if (!client || !client.isOpen) return true;
    const reservationId = randomUUID();
    const tokenCost = estimatedTokens(request);
    try {
      const reserved = await client.eval(RESERVE_USAGE_SCRIPT, {
        keys: [
          stateKey('rpm', key),
          dayKey('rpd', key),
          dayKey('tpd', key)
        ],
        arguments: [
          String(Date.now()),
          String(model.rpm || 0),
          String(model.rpd || 0),
          String(model.tpd || 0),
          String(tokenCost),
          reservationId,
          String(RPM_WINDOW_MS),
          String(Math.ceil(RPM_WINDOW_MS / 1000)),
          String(secondsUntilMidnight())
        ]
      });
      return Number(reserved) === 1 ? { key, reservationId, tokenCost } : false;
    } catch (_error) {
      return true;
    }
  }

  /* Best effort: a reservation for a call that never left is given back. */
  function releaseUsage(reservation) {
    if (!reservation || reservation === true || !client || !client.isOpen) return;
    const { key, reservationId, tokenCost } = reservation;
    const quietly = (fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch (_error) { /* never surfaces */ } };
    quietly(() => client.zRem(stateKey('rpm', key), reservationId));
    quietly(() => client.decrBy(dayKey('rpd', key), 1));
    if (tokenCost) quietly(() => client.decrBy(dayKey('tpd', key), tokenCost));
  }

  function mirrorFailures(key, modelState) {
    if (!client || !client.isOpen) return;
    client.del(stateKey('failures', key)).catch(() => {});
    if (!modelState.degradedUntil) client.del(stateKey('degraded', key)).catch(() => {});
  }

  function mirrorFailure(key, modelState) {
    if (!client || !client.isOpen) return;
    client.set(stateKey('failures', key), String(modelState.failures), { EX: 86400 }).catch(() => {});
    if (modelState.cooldownUntil) {
      const ttl = Math.max(1, Math.ceil((modelState.cooldownUntil - Date.now()) / 1000));
      client.set(stateKey('cooldown', key), '1', { EX: ttl }).catch(() => {});
    }
    if (modelState.degradedUntil) {
      const ttl = Math.max(1, Math.ceil((modelState.degradedUntil - Date.now()) / 1000));
      client.set(stateKey('degraded', key), '1', { EX: ttl }).catch(() => {});
    }
  }

  function disconnect() {
    if (client && client.isOpen) {
      client.disconnect().catch(() => {});
    }
    client = null;
  }

  return { connect, restoreState, reserveUsage, releaseUsage, mirrorFailure, mirrorFailures, disconnect };
}

/*
 * `request.candidates` : l'ordre de CETTE demande, à travers les fournisseurs
 * ([{ provider, model, ...champs du modèle }]). Un projet a souvent plusieurs
 * ordres pour les mêmes modèles (le plus rapide d'abord pour ce qu'on attend,
 * le plus capable d'abord pour le reste). Un fournisseur inconnu est ignoré ;
 * un modèle non déclaré par le fournisseur est pris tel que décrit.
 */
function explicitCandidates(providers, list) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return list.flatMap((entry) => {
    const provider = entry && byId.get(entry.provider);
    if (!provider || !entry.model) return [];
    const fields = { ...entry };
    delete fields.provider;
    delete fields.model;
    const declared = (provider.models || []).find((model) => model.id === entry.model);
    return [{ provider, model: { ...(declared || {}), ...fields, id: entry.model } }];
  });
}

function selectCandidates(providers, intentRouting, request) {
  if (Array.isArray(request.candidates)) {
    return explicitCandidates(providers, request.candidates).filter(({ model }) => supportsComplexity(model, request.complexity));
  }
  const preferred = request.intent && intentRouting[request.intent]
    ? intentRouting[request.intent].preferred || []
    : [];
  const candidates = [];

  providers.forEach(provider => {
    const models = provider.models || [];
    const preferredModels = preferred
      .map(id => models.find(model => model.id === id))
      .filter(Boolean);
    const otherModels = models.filter(model => !preferred.includes(model.id));

    [...preferredModels, ...otherModels].forEach(model => {
      if (supportsComplexity(model, request.complexity)) {
        candidates.push({ provider, model });
      }
    });
  });

  return candidates;
}

function supportsComplexity(model, complexity) {
  if (!complexity) return true;
  return Array.isArray(model.complexity) && model.complexity.includes(complexity);
}

function isModelAvailable(state, key, model, request, now) {
  const modelState = state.models[key] || createModelState();
  state.models[key] = modelState;

  if (isUntilActive(modelState.cooldownUntil, now)) return false;
  if (isUntilActive(modelState.degradedUntil, now)) return false;
  if (model.rpm && currentRpm(modelState, now) >= model.rpm) return false;
  if (model.rpd && modelState.rpdUsed >= model.rpd) return false;
  if (model.tpd && modelState.tpdUsed + estimatedTokens(request) > model.tpd) return false;
  return true;
}

function reserveUsage(state, key, request, now) {
  const modelState = state.models[key] || createModelState();
  const tokens = estimatedTokens(request);
  modelState.rpmWindow = modelState.rpmWindow.filter(ts => now - ts < RPM_WINDOW_MS);
  modelState.rpmWindow.push(now);
  modelState.rpdUsed += 1;
  modelState.tpdUsed += tokens;
  state.models[key] = modelState;
  /* Undo, for a call the breaker refused before it left. */
  return () => {
    const index = modelState.rpmWindow.lastIndexOf(now);
    if (index !== -1) modelState.rpmWindow.splice(index, 1);
    modelState.rpdUsed = Math.max(0, modelState.rpdUsed - 1);
    modelState.tpdUsed = Math.max(0, modelState.tpdUsed - tokens);
  };
}

function estimatedTokens(request) {
  return Math.max(0, Number(request.estimatedTokens || request.maxTokens || 0));
}

function currentRpm(modelState, now) {
  modelState.rpmWindow = modelState.rpmWindow.filter(ts => now - ts < RPM_WINDOW_MS);
  return modelState.rpmWindow.length;
}

function isUntilActive(until, now) {
  return Boolean(until && until > now);
}

function markFailure(state, modelId, error, options) {
  const modelState = state.models[modelId] || createModelState();
  modelState.failures = (modelState.failures || 0) + 1;

  if (options.cooldownOn(error)) {
    modelState.cooldownUntil = options.now() + options.cooldownMs + jitter(options.cooldownJitterMs);
  }

  if (modelState.failures >= options.maxFailures) {
    modelState.degradedUntil = options.now() + options.degradedMs;
  }

  state.models[modelId] = modelState;
}

function clearFailures(state, modelId) {
  const modelState = state.models[modelId] || createModelState();
  modelState.failures = 0;
  state.models[modelId] = modelState;
}

function modelKey(provider, model) {
  return `${provider.id}:${model.id}`;
}

/*
 * Une voie : une clé à part pour un usage (son propre quota gratuit). Elle se
 * repose seule — une clé saturée par un travail de fond n'arrête jamais les
 * conversations servies par la clé générale.
 */
function laneKey(provider, model, ctx) {
  const lane = typeof provider.lane === 'function' ? provider.lane(ctx) : null;
  return lane ? `${modelKey(provider, model)}@${lane}` : modelKey(provider, model);
}

function unavailable(code, message) {
  const error = new AppError(message, 503);
  error.code = code;
  return error;
}

/* Une demande abandonnée par l'appelant s'arrête net, avec la raison de l'appelant. */
function stopIfAborted(signal) {
  if (signal && signal.aborted) throw signal.reason;
}

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function isRateLimitError(error) {
  return error && (
    error.statusCode === 429 ||
    error.status === 429 ||
    error.code === 429 ||
    error.code === '429'
  );
}

function jitter(maxMs) {
  if (!maxMs) return 0;
  return Math.floor(Math.random() * maxMs);
}

function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

function resetDailyUsage(state) {
  Object.values(state.models).forEach(modelState => {
    modelState.rpdUsed = 0;
    modelState.tpdUsed = 0;
  });
}

module.exports = {
  createProviderRouter
};
