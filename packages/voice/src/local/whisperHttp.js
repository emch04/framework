'use strict';

/* global AbortController, FormData, Blob */

/**
 * Moteur « service HTTP » : un serveur faster-whisper (MIT) qui expose l'API
 * audio d'OpenAI — par exemple `speaches` ou `faster-whisper-server`. Transcription
 * sur `/v1/audio/transcriptions`, synthèse sur `/v1/audio/speech` si le serveur
 * la propose. Aucune dépendance ; `fetch` injectable.
 */
function createWhisperHttpEngine({
  baseUrl = 'http://127.0.0.1:8000',
  model = 'Systran/faster-whisper-small',
  ttsModel = null,
  ttsVoice = null,
  apiKey = null,
  timeoutMs = 120_000,
  fetch: fetchImpl = globalThis.fetch,
  id = 'faster-whisper'
} = {}) {
  let base;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocole');
    base = url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {
    throw new TypeError('INVALID_BASE_URL');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('FETCH_REQUIRED');

  async function call(route, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${route}`, {
        ...init,
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...init.headers },
        signal: controller.signal
      });
      if (!response.ok) {
        // `status` permet à classifyProviderError (@astratra/voice) de décider du repli.
        throw Object.assign(new Error(`Réponse HTTP ${response.status}`), { status: response.status });
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcribe({ audio, language = null, mediaType = 'audio/wav' } = {}) {
    if (!(audio instanceof Uint8Array) || audio.length === 0) throw Object.assign(new Error('EMPTY_AUDIO'), { code: 'EMPTY_AUDIO' });
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mediaType }), mediaType === 'audio/wav' ? 'audio.wav' : 'audio');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);
    const payload = await (await call('/v1/audio/transcriptions', { method: 'POST', body: form })).json();
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const logprobs = segments.map((s) => s.avg_logprob).filter(Number.isFinite);
    const noSpeech = segments.map((s) => s.no_speech_prob).filter(Number.isFinite);
    return {
      text: String(payload.text ?? '').trim(),
      heardLanguage: payload.language ?? language ?? null,
      ...(logprobs.length ? { logprob: logprobs.reduce((a, b) => a + b, 0) / logprobs.length } : {}),
      ...(noSpeech.length ? { noSpeechProbability: Math.max(...noSpeech) } : {})
    };
  }

  async function synthesize({ text, voice = null } = {}) {
    if (!ttsModel) throw Object.assign(new Error('SYNTHESIS_NOT_CONFIGURED'), { code: 'NOT_CONFIGURED' });
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('EMPTY_TEXT'), { code: 'EMPTY_TEXT' });
    const response = await call('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ttsModel, input: text, voice: voice ?? ttsVoice, response_format: 'wav' })
    });
    const audio = new Uint8Array(await response.arrayBuffer());
    if (!audio.length) throw Object.assign(new Error('EMPTY_AUDIO'), { code: 'EMPTY_AUDIO' });
    return { audio, format: 'wav', mimeType: 'audio/wav' };
  }

  return {
    id,
    engine: 'whisper-http',
    capabilities: { transcribe: true, synthesize: Boolean(ttsModel) },
    transcribe,
    synthesize,
    close() {}
  };
}

module.exports = { createWhisperHttpEngine };
