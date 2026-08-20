const rateLimit = require('express-rate-limit');
const { createLogger } = require('@astratra/core');

const logger = createLogger('rate-limiters');

const DEFAULT_API_MESSAGE = {
  success: false,
  message: 'Too many requests.'
};

const DEFAULT_LOGIN_MESSAGE = {
  success: false,
  message: 'Too many login attempts. Please try again later.'
};

const DEFAULT_ACCOUNT_MESSAGE = {
  success: false,
  message: 'Too many attempts for this account. Please try again later.'
};

const getIp = (req) => req.ip || req.connection?.remoteAddress || '';

const skipLocalhost = (req) => {
  const ip = getIp(req);
  return ip === '::1' || ip === '127.0.0.1' || ip.includes('localhost');
};

const sendLimitResponse = async (req, res, next, options, onBlocked, context) => {
  if (onBlocked) {
    await onBlocked(context);
  }

  return res.status(options.statusCode).json(options.message);
};

const createMemoryStore = () => {
  const MemoryStore = rateLimit.MemoryStore;
  return typeof MemoryStore === 'function' ? new MemoryStore() : null;
};

const createFailoverStore = (redisStore, memoryStore, connectPromise) => {
  let activeStore = memoryStore || redisStore;
  let initOptions = null;
  const initializedStores = new WeakSet();

  const initializeStore = (store) => {
    if (!store || initializedStores.has(store)) return;
    if (initOptions && typeof store.init === 'function') {
      store.init(initOptions);
    }
    initializedStores.add(store);
  };

  const useStore = (store) => {
    activeStore = store || memoryStore || redisStore;
    initializeStore(activeStore);
  };

  connectPromise.then(
    () => useStore(redisStore),
    () => useStore(memoryStore)
  );

  const callActiveStore = (method, args) => {
    const fn = activeStore && activeStore[method];
    if (typeof fn !== 'function') return undefined;
    return fn.apply(activeStore, args);
  };

  return {
    init(options) {
      initOptions = options;
      initializeStore(activeStore);
    },
    increment(...args) {
      return callActiveStore('increment', args);
    },
    decrement(...args) {
      return callActiveStore('decrement', args);
    },
    resetKey(...args) {
      return callActiveStore('resetKey', args);
    },
    resetAll(...args) {
      return callActiveStore('resetAll', args);
    },
    get(...args) {
      return callActiveStore('get', args);
    },
    shutdown(...args) {
      if (redisStore && typeof redisStore.shutdown === 'function') {
        redisStore.shutdown(...args);
      }
      if (memoryStore && typeof memoryStore.shutdown === 'function') {
        memoryStore.shutdown(...args);
      }
    }
  };
};

const createRedisStore = (redisUrl, prefix) => {
  if (!redisUrl) return undefined;

  let RedisModule;
  let RateLimitRedisModule;
  try {
    RedisModule = require('redis');
    RateLimitRedisModule = require('rate-limit-redis');
  } catch (_error) {
    return undefined;
  }

  const RedisStore = RateLimitRedisModule.RedisStore || RateLimitRedisModule.default || RateLimitRedisModule;
  if (typeof RedisStore !== 'function' || typeof RedisModule.createClient !== 'function') {
    return undefined;
  }

  try {
    const client = RedisModule.createClient({ url: redisUrl });
    if (client && typeof client.on === 'function') {
      client.on('error', () => {});
    }

    const redisStore = new RedisStore({
      ...(prefix ? { prefix } : {}),
      sendCommand: (...args) => client.sendCommand(args)
    });
    const memoryStore = createMemoryStore();
    const connectPromise = Promise.resolve(client.connect()).catch(() => {
      if (client && client.isOpen && typeof client.disconnect === 'function') {
        client.disconnect().catch(() => {});
      }
      throw new Error('Redis rate limit store unavailable');
    });

    return createFailoverStore(redisStore, memoryStore, connectPromise);
  } catch (_error) {
    return createMemoryStore() || undefined;
  }
};

// Store Redis générique : le namespace est choisi par le projet consommateur.
// Astratra ne connaît donc aucun domaine métier (auth, commandes, réservations…).
const createRedisRateLimitStore = ({ redisUrl, prefix } = {}) => createRedisStore(redisUrl, prefix);

const resolveStore = (options) => {
  if (options.store) return options.store;
  return createRedisStore(options.redisUrl);
};

const withOptionalStore = (limiterOptions, store) => {
  if (!store) return limiterOptions;
  return { ...limiterOptions, store };
};

const defaultApiSkip = () => (process.env.NODE_ENV === 'production' ? undefined : skipLocalhost);

const createApiLimiter = (options = {}) => rateLimit(withOptionalStore({
  windowMs: options.windowMs || 15 * 60 * 1000,
  max: options.max || 300,
  skip: options.skip ?? defaultApiSkip(),
  standardHeaders: options.standardHeaders ?? true,
  legacyHeaders: options.legacyHeaders ?? false,
  validate: options.validate || { ip: false },
  message: options.message || DEFAULT_API_MESSAGE
}, resolveStore(options)));

const createLoginLimiter = (options = {}) => rateLimit(withOptionalStore({
  windowMs: options.windowMs || 15 * 60 * 1000,
  max: options.max || 10,
  skip: options.skip,
  standardHeaders: options.standardHeaders ?? true,
  legacyHeaders: options.legacyHeaders ?? false,
  validate: options.validate || { ip: false },
  message: options.message || DEFAULT_LOGIN_MESSAGE,
  handler: (req, res, next, limitOptions) => sendLimitResponse(
    req,
    res,
    next,
    limitOptions,
    options.onBlocked,
    { ip: getIp(req), req }
  )
}, resolveStore(options)));

// Avertit une seule fois par processus (fonction partagée par toute instance
// de createAccountLimiter utilisant la clé par défaut) : le problème est un
// ordre de montage figé au démarrage, pas quelque chose qui varie requête par
// requête.
let warnedUnparsedBody = false;

const defaultAccountKeyGenerator = (req) => {
  // Même défaut de conception que le WAF (voir waf.js) : req.body est
  // `undefined` si createAccountLimiter() est monté avant express.json().
  // Sans cette détection, toute tentative de connexion retombait alors sur la
  // clé partagée "unknown" — plus de limite PAR COMPTE, une seule limite
  // globale pour tous les comptes confondus. Deux effets, tous deux mauvais :
  // un attaquant peut essayer des mots de passe sur des comptes DIFFÉRENTS
  // sans jamais être freiné par compte, et des utilisateurs légitimes sans
  // rapport entre eux peuvent se faire bloquer les uns par les autres.
  if (req.body === undefined && !warnedUnparsedBody) {
    warnedUnparsedBody = true;
    logger.warn(
      'req.body est undefined dans createAccountLimiter() — à monter APRÈS ' +
      "express.json()/express.urlencoded(), sinon toutes les tentatives sont " +
      'regroupées sous la même clé "unknown" au lieu d\'être limitées par compte.'
    );
  }

  const body = req.body || {};
  const identifier = body.email || body.identifier || 'unknown';
  return String(identifier).toLowerCase();
};

const createAccountLimiter = (options = {}) => {
  const keyGenerator = options.keyGenerator || defaultAccountKeyGenerator;

  return rateLimit(withOptionalStore({
    windowMs: options.windowMs || 30 * 60 * 1000,
    max: options.max || 20,
    skip: options.skip,
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
    validate: options.validate || { ip: false },
    keyGenerator,
    message: options.message || DEFAULT_ACCOUNT_MESSAGE,
    handler: (req, res, next, limitOptions) => {
      const body = req.body || {};
      const identifier = body.email || body.identifier || 'unknown';
      return sendLimitResponse(
        req,
        res,
        next,
        limitOptions,
        options.onBlocked,
        { identifier, ip: getIp(req), req }
      );
    }
  }, resolveStore(options)));
};

module.exports = {
  createRedisRateLimitStore,
  createApiLimiter,
  createLoginLimiter,
  createAccountLimiter,
  skipLocalhost
};
