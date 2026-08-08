const { AppError } = require('@astratra/core');

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_COOLDOWN_JITTER_MS = 8 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_DEGRADED_MS = 5 * 60 * 1000;
const RPM_WINDOW_MS = 60 * 1000;

function createProviderRouter(config = {}) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const state = createInitialState(providers);
  const options = {
    cooldownMs: config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    cooldownJitterMs: config.cooldownJitterMs ?? DEFAULT_COOLDOWN_JITTER_MS,
    maxFailures: config.maxFailures ?? DEFAULT_MAX_FAILURES,
    degradedMs: config.degradedMs ?? DEFAULT_DEGRADED_MS,
    intentRouting: config.intentRouting || {},
    redisKeyPrefix: config.redisKeyPrefix || 'astratra:ai:provider'
  };
  let midnightTimer = null;
  const resetDailyAtMidnight = () => {
    resetDailyUsage(state);
    midnightTimer = setTimeout(resetDailyAtMidnight, msUntilNextMidnight());
  };
  midnightTimer = setTimeout(resetDailyAtMidnight, msUntilNextMidnight());

  const redis = createRedisLink(config, options);
  const redisReady = redis.connect().then(() => redis.restoreState(state)).catch(() => {});

  async function ask(prompt, request = {}, ctx = {}) {
    await redisReady;
    const candidates = selectCandidates(providers, options.intentRouting, request);
    const errors = [];

    for (const candidate of candidates) {
      const { provider, model } = candidate;
      if (!isModelAvailable(state, model, request)) continue;

      reserveUsage(state, model, request);
      redis.mirrorUsage(model.id, state.models[model.id]);

      try {
        const result = await provider.call(prompt, ctx, model);
        clearFailures(state, model.id);
        redis.mirrorFailures(model.id, state.models[model.id]);
        return result;
      } catch (error) {
        errors.push(error);
        markFailure(state, model.id, error, options);
        redis.mirrorFailure(model.id, state.models[model.id]);
      }
    }

    const suffix = errors.length ? ` Last error: ${errors[errors.length - 1].message}` : '';
    throw new AppError(`No available AI provider/model for this request.${suffix}`, 503);
  }

  function getStats() {
    const now = Date.now();
    const stats = {};
    providers.forEach(provider => {
      (provider.models || []).forEach(model => {
        const modelState = state.models[model.id] || createModelState();
        stats[model.id] = {
          provider: provider.id,
          rpm_now: currentRpm(modelState, now),
          rpm_limit: model.rpm ?? null,
          rpd_used: modelState.rpdUsed,
          rpd_limit: model.rpd ?? null,
          tpd_used: modelState.tpdUsed,
          tpd_limit: model.tpd ?? null,
          cooldown: isUntilActive(modelState.cooldownUntil, now),
          degraded: isUntilActive(modelState.degradedUntil, now),
          failures: modelState.failures || 0
        };
      });
    });
    return stats;
  }

  function stop() {
    if (midnightTimer) {
      clearTimeout(midnightTimer);
      midnightTimer = null;
    }
    redis.disconnect();
  }

  return { ask, getStats, stop };
}

function createInitialState(providers) {
  const state = { models: {} };
  providers.forEach(provider => {
    (provider.models || []).forEach(model => {
      state.models[model.id] = createModelState();
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

// Redis is a best-effort, optional shared-state layer: if it's absent,
// misconfigured, or fails at any point, the router must keep working with
// its in-memory state only — never let Redis trouble block or crash a call.
function createRedisLink(config, options) {
  const noop = {
    connect: async () => {},
    restoreState: async () => {},
    mirrorUsage: () => {},
    mirrorFailure: () => {},
    mirrorFailures: () => {},
    disconnect: () => {}
  };

  if (!config.redisUrl) return noop;

  let client = null;
  const prefix = options.redisKeyPrefix;
  const dayKey = (type, modelId) => `${prefix}:${type}:${modelId}:${new Date().toDateString()}`;
  const stateKey = (type, modelId) => `${prefix}:${type}:${modelId}`;
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
      for (const [modelId, modelState] of Object.entries(state.models)) {
        const [rpd, tpd, failures, cooldownTtl, degradedTtl] = await Promise.all([
          client.get(dayKey('rpd', modelId)),
          client.get(dayKey('tpd', modelId)),
          client.get(stateKey('failures', modelId)),
          client.ttl(stateKey('cooldown', modelId)),
          client.ttl(stateKey('degraded', modelId))
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

  function mirrorUsage(modelId, modelState) {
    if (!client || !client.isOpen) return;
    const ttl = secondsUntilMidnight();
    client.incrBy(dayKey('rpd', modelId), 1).catch(() => {});
    client.expire(dayKey('rpd', modelId), ttl).catch(() => {});
    if (modelState.tpdUsed) {
      client.set(dayKey('tpd', modelId), String(modelState.tpdUsed), { EX: ttl }).catch(() => {});
    }
  }

  function mirrorFailures(modelId, modelState) {
    if (!client || !client.isOpen) return;
    client.del(stateKey('failures', modelId)).catch(() => {});
    if (!modelState.degradedUntil) client.del(stateKey('degraded', modelId)).catch(() => {});
  }

  function mirrorFailure(modelId, modelState) {
    if (!client || !client.isOpen) return;
    client.set(stateKey('failures', modelId), String(modelState.failures), { EX: 86400 }).catch(() => {});
    if (modelState.cooldownUntil) {
      const ttl = Math.max(1, Math.ceil((modelState.cooldownUntil - Date.now()) / 1000));
      client.set(stateKey('cooldown', modelId), '1', { EX: ttl }).catch(() => {});
    }
    if (modelState.degradedUntil) {
      const ttl = Math.max(1, Math.ceil((modelState.degradedUntil - Date.now()) / 1000));
      client.set(stateKey('degraded', modelId), '1', { EX: ttl }).catch(() => {});
    }
  }

  function disconnect() {
    if (client && client.isOpen) {
      client.disconnect().catch(() => {});
    }
    client = null;
  }

  return { connect, restoreState, mirrorUsage, mirrorFailure, mirrorFailures, disconnect };
}

function selectCandidates(providers, intentRouting, request) {
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

function isModelAvailable(state, model, request) {
  const now = Date.now();
  const modelState = state.models[model.id] || createModelState();
  state.models[model.id] = modelState;

  if (isUntilActive(modelState.cooldownUntil, now)) return false;
  if (isUntilActive(modelState.degradedUntil, now)) return false;
  if (model.rpm && currentRpm(modelState, now) >= model.rpm) return false;
  if (model.rpd && modelState.rpdUsed >= model.rpd) return false;
  if (model.tpd && modelState.tpdUsed + estimatedTokens(request) > model.tpd) return false;
  return true;
}

function reserveUsage(state, model, request) {
  const modelState = state.models[model.id] || createModelState();
  const now = Date.now();
  modelState.rpmWindow = modelState.rpmWindow.filter(ts => now - ts < RPM_WINDOW_MS);
  modelState.rpmWindow.push(now);
  modelState.rpdUsed += 1;
  modelState.tpdUsed += estimatedTokens(request);
  state.models[model.id] = modelState;
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

  if (isRateLimitError(error)) {
    modelState.cooldownUntil = Date.now() + options.cooldownMs + jitter(options.cooldownJitterMs);
  }

  if (modelState.failures >= options.maxFailures) {
    modelState.degradedUntil = Date.now() + options.degradedMs;
  }

  state.models[modelId] = modelState;
}

function clearFailures(state, modelId) {
  const modelState = state.models[modelId] || createModelState();
  modelState.failures = 0;
  state.models[modelId] = modelState;
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
