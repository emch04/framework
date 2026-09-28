'use strict';

const { createHash } = require('node:crypto');
const { VOICE_VERSION, buildVoiceCacheKey, normalizeLanguage } = require('./builders');

function classifyProviderError(error) {
  const status = Number(error?.status);
  if (status === 429 || ['QUOTA', 'QUOTA_EXCEEDED', 'RATE_LIMITED'].includes(error?.code)) return 'QUOTA';
  if (status === 401 || status === 403 || error?.code === 'AUTH') return 'AUTH';
  if (status >= 500 || error?.name === 'AbortError' || ['ETIMEDOUT', 'ECONNRESET', 'TRANSIENT'].includes(error?.code)) return 'TRANSIENT';
  return error?.code === 'INVALID_AUDIO' || error?.code === 'EMPTY_AUDIO' ? 'INVALID_AUDIO' : 'PROVIDER_ERROR';
}

function identity(provider, model, key) {
  return createHash('sha256').update(JSON.stringify([provider, model, key ?? null])).digest('hex');
}

function providerCacheKey(text, language, version, provider, voice) {
  return buildVoiceCacheKey(JSON.stringify([text, provider, voice ?? null]), { language, version });
}

/** Ordered providers and models, rotating keys with optional shared cooldown storage. */
function createProviderVoiceService(options = {}) {
  const providers = options.providers || [];
  const clock = options.clock || { now: Date.now };
  const cooldownMs = options.cooldownMs ?? 60 * 60 * 1000;
  const voiceVersion = String(options.voiceVersion || VOICE_VERSION);
  const cooldowns = new Map();
  let cursor = 0;

  async function cooldownFor(id) {
    let persisted;
    try { persisted = await options.cooldownStore?.getCooldown(id); } catch (_error) { /* Local state remains usable. */ }
    return Math.max(cooldowns.get(id) || 0, Number(persisted) || 0);
  }
  async function rest(id, durationMs) {
    const until = clock.now() + durationMs;
    cooldowns.set(id, until);
    try { await options.cooldownStore?.setCooldown(id, until); } catch (_error) { /* Optional store. */ }
  }
  async function cached(key, provider, fallback, attempts) {
    if (!options.cache) return null;
    try {
      const entry = await options.cache.get(key);
      if (entry?.audio != null) return { ...entry, audio: Buffer.from(entry.audio), cacheKey: key, cached: true, provider, fallback, attempts };
    } catch (_error) { /* Cache outages become misses. */ }
    return null;
  }

  async function synthesize(request = {}) {
    const text = String(request.text ?? '').trim();
    if (!text) throw Object.assign(new Error('TEXT_REQUIRED'), { code: 'TEXT_REQUIRED' });
    const language = normalizeLanguage(request.language, 'auto');
    const version = String(request.voiceVersion || voiceVersion);
    const attempts = [];
    let pinned;
    if (request.fallbackScope) {
      try { pinned = await options.fallbackStore?.get(request.fallbackScope); } catch (_error) { /* Optional store. */ }
    }
    if (pinned && !providers.some((provider, index) => (provider?.id || `provider_${index}`) === pinned)) pinned = null;
    for (let position = 0; position < providers.length; position += 1) {
      const provider = providers[position];
      if (!provider || typeof provider.synthesize !== 'function') continue;
      const providerId = provider.id || `provider_${position}`;
      if (pinned && providerId !== pinned) continue;
      const voice = request.voice ?? provider.voice ?? null;
      const cacheKey = providerCacheKey(text, language, version, providerId, voice);
      const hit = await cached(cacheKey, providerId, position > 0, attempts);
      if (hit) {
        if (position > 0 && request.fallbackScope) {
          try { await options.fallbackStore?.set(request.fallbackScope, providerId, options.fallbackTtlSeconds ?? 300); } catch (_error) { /* Optional scope store. */ }
        }
        return hit;
      }
      let keys;
      try { keys = typeof provider.keys === 'function' ? await provider.keys() : provider.keys; }
      catch (_error) { attempts.push({ provider: providerId, code: 'KEYS_UNAVAILABLE' }); continue; }
      const candidates = Array.isArray(keys) ? [...new Set(keys.filter(Boolean))] : [undefined];
      const offset = candidates.length ? cursor++ % candidates.length : 0;
      const models = provider.models?.length ? provider.models : [provider.model];
      for (const model of models) {
        for (let i = 0; i < candidates.length; i += 1) {
          const key = candidates[(i + offset) % candidates.length];
          const id = identity(providerId, model, key);
          if (await cooldownFor(id) > clock.now()) continue;
          const dayId = `${new Date(clock.now()).toISOString().slice(0, 10)}:${id}`;
          if (options.usageStore && key !== undefined) {
            try {
              if ((await options.usageStore.getCount(dayId)) >= (options.maxSuccessesPerDay ?? 9)) continue;
            } catch (_error) { /* Provider remains available if tracking fails. */ }
          }
          try {
            const result = await provider.synthesize({ ...request, text, language, voice, model, key });
            if (!result || result.audio == null || !result.audio.length) throw Object.assign(new Error('EMPTY_AUDIO'), { code: 'EMPTY_AUDIO' });
            const entry = { audio: Buffer.from(result.audio), format: result.format, mimeType: result.mimeType };
            if (key !== undefined) {
              try { await options.usageStore?.increment(dayId); } catch (_error) { /* Optional usage store. */ }
            }
            try { await options.cache?.set(cacheKey, entry, options.cacheTtlSeconds ?? 604800); } catch (_error) { /* Optional cache. */ }
            if (position > 0 && request.fallbackScope) {
              try { await options.fallbackStore?.set(request.fallbackScope, providerId, options.fallbackTtlSeconds ?? 300); } catch (_error) { /* Optional scope store. */ }
            }
            return { ...entry, audio: Buffer.from(entry.audio), cacheKey, cached: false, provider: providerId, model: model ?? null, fallback: position > 0, attempts };
          } catch (error) {
            const code = classifyProviderError(error);
            attempts.push({ provider: providerId, model: model ?? null, code });
            const restMs = options.cooldownMsByCode?.[code] ?? (code === 'QUOTA' ? cooldownMs : 0);
            if (restMs > 0) await rest(id, restMs);
          }
        }
      }
    }
    throw Object.assign(new Error('PROVIDERS_UNAVAILABLE'), { code: 'PROVIDERS_UNAVAILABLE', attempts });
  }
  return { synthesize, voiceVersion };
}

function createPiperProvider(service, id = 'piper') {
  return { id, synthesize: ({ text, language }) => service.synthesize({ text, language }) };
}

function pcm16ToWav(pcm, rate) {
  if (!pcm.length || pcm.length % 2 || !Number.isInteger(rate) || rate <= 0) throw Object.assign(new Error('INVALID_AUDIO'), { code: 'INVALID_AUDIO' });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Gemini wire adapter; endpoint, fetch, keys, voices and timeout are caller owned. */
function createGeminiTtsAdapter({ fetch, endpoint, model, models, voice, voices, id = 'gemini', keys, timeoutMs = 15000, wireStyle = 'snake' }) {
  if (typeof fetch !== 'function' || typeof endpoint !== 'function') throw new TypeError('FETCH_AND_ENDPOINT_REQUIRED');
  return {
    id, keys, model, models, voice,
    async synthesize({ text, key, language, model: selectedModel, voice: requestedVoice }) {
      const chosenModel = selectedModel || model;
      const chosenVoice = requestedVoice || voices?.[language] || voice;
      const generationConfig = wireStyle === 'camel'
        ? { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: chosenVoice } } } }
        : { response_modalities: ['AUDIO'], speech_config: { voice_config: { prebuilt_voice_config: { voice_name: chosenVoice } } } };
      const response = await fetch(endpoint(chosenModel), {
        method: 'POST', signal: globalThis.AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig })
      });
      if (!response.ok) throw Object.assign(new Error('PROVIDER_HTTP_ERROR'), { status: response.status, code: classifyProviderError({ status: response.status }) });
      const body = await response.json();
      const part = body?.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data)?.inlineData;
      if (!part) throw Object.assign(new Error('INVALID_AUDIO'), { code: 'INVALID_AUDIO' });
      if (/^audio\/(?:wav|x-wav)/i.test(part.mimeType || '')) return { audio: Buffer.from(part.data, 'base64'), format: 'wav', mimeType: 'audio/wav' };
      if (!/^audio\/L16/i.test(part.mimeType || '')) throw Object.assign(new Error('INVALID_AUDIO'), { code: 'INVALID_AUDIO' });
      const rate = Number(/rate=(\d+)/i.exec(part.mimeType)?.[1] || 24000);
      return { audio: pcm16ToWav(Buffer.from(part.data, 'base64'), rate), format: 'wav', mimeType: 'audio/wav' };
    }
  };
}

module.exports = { classifyProviderError, createProviderVoiceService, createPiperProvider, createGeminiTtsAdapter };
