'use strict';

// Only reads the supplied environment object. Never opens an .env file.
function readAiConfigFromEnv({ env = process.env, prefix = 'IA_' } = {}) {
  const read = (name) => env[prefix + name];
  const json = (name, fallback) => {
    if (!read(name)) return fallback;
    try { return JSON.parse(read(name)); }
    catch { throw new TypeError(`INVALID_AI_CONFIG_${name}`); }
  };
  const number = (name, fallback) => {
    if (read(name) == null || read(name) === '') return fallback;
    const value = Number(read(name));
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return value;
  };
  const boolean = (name, fallback) => {
    if (!read(name)) return fallback;
    if (!['true', 'false', '1', '0'].includes(read(name))) throw new TypeError(`INVALID_AI_CONFIG_${name}`);
    return ['true', '1'].includes(read(name));
  };
  const providers = json('PROVIDERS', []);
  if (!Array.isArray(providers)) throw new TypeError('INVALID_AI_CONFIG_PROVIDERS');
  const usages = {};
  for (const usage of ['quick', 'chat', 'tools', 'pilot', 'json', 'vision']) {
    const list = json(`MODELS_${usage.toUpperCase()}`, undefined);
    if (list !== undefined) {
      if (!Array.isArray(list) || list.some((entry) => !entry?.provider || !entry.model)) throw new TypeError(`INVALID_AI_CONFIG_MODELS_${usage.toUpperCase()}`);
      usages[usage] = list;
    }
  }
  const config = {
    providers: providers.map((provider) => {
      const stem = provider.envName || provider.id?.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (!stem) throw new TypeError('INVALID_AI_CONFIG_PROVIDER_ID');
      // Re-read keys at every request: settings screens can replace them live.
      const keys = (ctx = {}) => readEnvironmentKeys(ctx.env || env, `${prefix}${stem}_KEY`);
      return { ...provider, url: read(`${stem}_URL`) || provider.url, local: boolean(`${stem}_LOCAL`, provider.local), keys };
    }),
    usages,
    intentRouting: json('INTENT_ROUTING', {}),
    statePrefix: read('STATE_PREFIX') || 'routing:',
    quotaMargin: json('QUOTA_MARGIN', { rpm: 0.75, rpd: 0.9, tpd: 0.85 }),
    tokenBuffer: number('TOKEN_BUFFER', 1.2),
    waitedTimeoutMs: number('WAITED_TIMEOUT_MS', 12000),
    backgroundTimeoutMs: number('BACKGROUND_TIMEOUT_MS', 45000),
    cooldownMs: number('COOLDOWN_MS', 120000),
    cooldownJitterMs: number('COOLDOWN_JITTER_MS', 0),
    degradedMs: number('DEGRADED_MS', 300000),
    maxFailures: number('MAX_FAILURES', 3),
    whenAllCooling: read('WHEN_ALL_COOLING') || 'skip',
    reserveVision: boolean('RESERVE_VISION', false),
    localModels: { baseUrl: read('MODELS_URL'), tokenFile: read('MODELS_TOKEN_FILE') },
    language: { baseUrl: read('LANGUAGE_URL'), timeoutMs: number('LANGUAGE_TIMEOUT_MS', 800) },
    voice: {
      piper: { baseUrl: read('TTS_URL'), tokenFile: read('TTS_TOKEN_FILE') },
      groq: { url: read('GROQ_WHISPER_URL') || 'https://api.groq.com/openai/v1/audio/transcriptions', keys: () => readEnvironmentKeys(env, prefix + 'GROQ_KEY'), models: json('GROQ_WHISPER_MODELS', ['whisper-large-v3-turbo', 'whisper-large-v3']) },
      cloudflare: { url: read('CLOUDFLARE_WHISPER_URL') || (read('CLOUDFLARE_ACCOUNT_ID') ? `https://api.cloudflare.com/client/v4/accounts/${read('CLOUDFLARE_ACCOUNT_ID')}/ai/run/@cf/openai/whisper-large-v3-turbo` : undefined), keys: () => readEnvironmentKeys(env, prefix + 'CLOUDFLARE_KEY') },
      gemini: { endpoint: read('GEMINI_TTS_ENDPOINT'), keys: () => readEnvironmentKeys(env, prefix + 'GEMINI_KEY'), models: json('GEMINI_TTS_MODELS', ['gemini-2.5-flash-preview-tts']), voice: read('GEMINI_TTS_VOICE') || 'Aoede' }
    }
  };
  if (!['skip', 'try'].includes(config.whenAllCooling)) throw new TypeError('INVALID_AI_CONFIG_WHEN_ALL_COOLING');
  return config;
}

function readEnvironmentKeys(env, name) {
  // Sparse suffixes work as well; a missing _2 must not hide _3.
  const names = Object.keys(env).filter((key) => key === name || (key.startsWith(name + '_') && /^\d+$/.test(key.slice(name.length + 1))))
    .sort((a, b) => (a === name ? 0 : Number(a.slice(name.length + 1))) - (b === name ? 0 : Number(b.slice(name.length + 1))));
  return [...new Set(names.map((key) => env[key]).filter((key) => typeof key === 'string' && key.trim()))];
}
module.exports = { readAiConfigFromEnv, readEnvironmentKeys };
