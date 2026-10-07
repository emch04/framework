'use strict';
const { createLocalModelsClient, validPcmAudio } = require('./localModels');
const { createTokenFileReader, serviceRequest, endpoint, AiServiceError } = require('./serviceHttp');
const { plainText } = require('./answerText');

const WHISPER_STOCK_PHRASES = Object.freeze(['sous-titr', 'amara.org', "merci d'avoir regard", 'merci d’avoir regard', 'abonnez-vous', 'thank for watching', 'thanks for watching', 'subtitle by', 'subtitles by', 'please subscribe']);

function pcmToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bytes = Buffer.from(pcm);
  if (!bytes.length || bytes.length % (channels * 2) || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || channels > 2) throw new AiServiceError('AI_AUDIO_INPUT');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

function readPcmWav(audio) {
  const bytes = Buffer.from(audio);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 > bytes.length) throw new AiServiceError('AI_AUDIO_RESPONSE');
  let format;
  let pcm;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > bytes.length) throw new AiServiceError('AI_AUDIO_RESPONSE');
    if (name === 'fmt ' && size >= 16) format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (name === 'data') pcm = bytes.subarray(start, start + size);
    at = start + size + size % 2;
  }
  if (!format || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || !format.sampleRate || !pcm?.length || pcm.length % (format.channels * 2)) throw new AiServiceError('AI_AUDIO_RESPONSE');
  return { pcm, sampleRate: format.sampleRate, channels: format.channels };
}

function speakableText(text, maxChars = 6000) {
  return plainText(String(text ?? '')).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function doubtfulTranscription(text, { stockPhrases = WHISPER_STOCK_PHRASES } = {}) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/\p{L}+/gu) || [];
  if (stockPhrases.some((phrase) => lower.includes(phrase))) return true;
  if (words.length >= 6 && new Set(words).size <= 2) return true;
  return false;
}

function rotatingPool(config = {}, now) {
  const rests = new Map();
  let next = 0;
  return {
    async candidates(defaultModels) {
      const source = typeof config.keys === 'function' ? await config.keys() : config.keys;
      const keys = [...new Set((Array.isArray(source) ? source : [source]).filter(Boolean))];
      const start = keys.length ? next++ % keys.length : 0;
      const list = [];
      for (const model of config.models || defaultModels) for (let offset = 0; offset < keys.length; offset += 1) {
        const slot = (start + offset) % keys.length;
        const id = `${model}:key-${slot + 1}`;
        if ((rests.get(id) || 0) <= now()) list.push({ model, key: keys[slot], id });
      }
      return list;
    },
    rest(id) { rests.set(id, now() + (config.cooldownMs ?? 120000)); }
  };
}

function createTranscriptionService(options = {}) {
  const local = options.local || createLocalModelsClient({ fetch: options.fetch, ...(options.localModels || {}) });
  const now = options.now || Date.now;
  const groq = options.groq || {};
  const cloudflare = options.cloudflare || {};
  const groqPool = rotatingPool(groq, now);
  const cloudPool = rotatingPool(cloudflare, now);
  const fetchImpl = options.fetch || globalThis.fetch;
  async function transcribe({ audio, format = 'pcm16', language = 'fr', vocabulary = '', filename = 'audio.wav', mimeType = 'audio/wav', signal, allowRemote = true } = {}) {
    const bytes = typeof audio === 'string' ? Buffer.from(audio, 'base64') : Buffer.from(audio || []);
    if (!bytes.length || bytes.length > (options.maxAudioBytes ?? 25000000)) throw new AiServiceError('AI_AUDIO_INPUT');
    let pcm;
    let file = bytes;
    if (format === 'pcm16') {
      if (!validPcmAudio(bytes.toString('base64'))) throw new AiServiceError('AI_AUDIO_INPUT');
      pcm = bytes;
      file = pcmToWav(pcm);
      filename = 'audio.wav'; mimeType = 'audio/wav';
    } else if (format === 'wav') {
      const wave = readPcmWav(bytes);
      if (wave.sampleRate === 16000 && wave.channels === 1 && validPcmAudio(wave.pcm.toString('base64'))) pcm = wave.pcm;
    } else if (format !== 'file') throw new AiServiceError('AI_AUDIO_INPUT');
    if (signal?.aborted) throw signal.reason;
    if (pcm) {
      const result = await local.transcrire(pcm.toString('base64'), { langue: language, vocabulaire: vocabulary, timeoutMs: options.localTimeoutMs ?? 15000, signal });
      if (result) {
        // Genuine silence is an answer, not an outage to send to another model.
        const silence = result.sansParole > (options.noSpeechThreshold ?? 0.6);
        const doubtful = result.logprob < (options.logprobThreshold ?? -1) || doubtfulTranscription(result.texte, options);
        if (silence || !doubtful) return { text: silence ? '' : result.texte, language: result.langue, provider: 'local', model: 'whisper', confidence: Math.exp(Math.min(0, result.logprob)), noSpeech: silence, fallback: false };
      }
    }
    if (!allowRemote) throw new AiServiceError('AI_TRANSCRIPTION_UNAVAILABLE');
    for (const candidate of await groqPool.candidates(['whisper-large-v3-turbo', 'whisper-large-v3'])) {
      if (!groq.url) break;
      try {
        const form = new globalThis.FormData();
        form.set('file', new globalThis.Blob([file], { type: mimeType }), filename);
        form.set('model', candidate.model); form.set('response_format', 'verbose_json');
        if (language) form.set('language', language);
        if (vocabulary) form.set('prompt', vocabulary);
        const data = await serviceRequest(groq.url, { fetch: fetchImpl, timeoutMs: groq.timeoutMs ?? 30000, signal, rawBody: form, headers: { Authorization: `Bearer ${candidate.key}` } });
        if (typeof data?.text !== 'string' || doubtfulTranscription(data.text, options)) throw new AiServiceError('AI_SERVICE_RESPONSE');
        return { text: data.text, language: data.language || null, provider: 'groq', model: candidate.model, fallback: true };
      } catch (_error) { if (signal?.aborted) throw signal.reason; groqPool.rest(candidate.id); }
    }
    for (const candidate of await cloudPool.candidates(['@cf/openai/whisper-large-v3-turbo'])) {
      if (!cloudflare.url) break;
      try {
        const data = await serviceRequest(typeof cloudflare.url === 'function' ? cloudflare.url(candidate.model) : cloudflare.url, { fetch: fetchImpl, timeoutMs: cloudflare.timeoutMs ?? 30000, signal, body: { audio: file.toString('base64') }, headers: { Authorization: `Bearer ${candidate.key}` } });
        if (data?.success === false || typeof data?.result?.text !== 'string' || doubtfulTranscription(data.result.text, options)) throw new AiServiceError('AI_SERVICE_RESPONSE');
        return { text: data.result.text, language: data.result.language || null, provider: 'cloudflare', model: candidate.model, fallback: true };
      } catch (_error) { if (signal?.aborted) throw signal.reason; cloudPool.rest(candidate.id); }
    }
    throw new AiServiceError('AI_TRANSCRIPTION_UNAVAILABLE');
  }
  return { transcribe };
}

function createSpeechService(options = {}) {
  const piper = options.piper || {};
  const gemini = options.gemini || {};
  const now = options.now || Date.now;
  const token = createTokenFileReader({ tokenFile: piper.tokenFile, read: piper.readTokenFile, now });
  const pool = rotatingPool(gemini, now);
  const fetchImpl = options.fetch || globalThis.fetch;
  const piperRests = new Map();
  /* Gemini (en ligne) d'abord, Piper (local) en repli ; `options.order` permet l'inverse. */
  const order = Array.isArray(options.order) && options.order.length ? options.order : ['gemini', 'piper'];
  async function viaPiper(clean, language, signal) {
    if (!piper.baseUrl || (piperRests.get(language) || 0) > now()) return null;
    try {
      const key = await token();
      const audio = await serviceRequest(endpoint(piper.baseUrl, '/tts'), { fetch: fetchImpl, body: { text: clean, lang: language }, signal, timeoutMs: piper.timeoutMs ?? 30000, read: 'bytes', headers: key ? { Authorization: `Bearer ${key}` } : {} });
      const wave = readPcmWav(audio);
      return { audio, format: 'wav', mimeType: 'audio/wav', sampleRate: wave.sampleRate, channels: wave.channels, provider: 'piper', model: null };
    } catch (_error) { if (signal?.aborted) throw signal.reason; piperRests.set(language, now() + (piper.cooldownMs ?? 60000)); return null; }
  }
  async function viaGemini(clean, signal) {
    for (const candidate of await pool.candidates(['gemini-2.5-flash-preview-tts'])) {
      try {
        const data = await serviceRequest(endpoint(gemini.endpoint || 'https://generativelanguage.googleapis.com/v1beta/models', `/${candidate.model}:generateContent`), {
          fetch: fetchImpl, signal, timeoutMs: gemini.timeoutMs ?? 45000, headers: { 'x-goog-api-key': candidate.key },
          body: { contents: [{ role: 'user', parts: [{ text: clean }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: gemini.voice || 'Aoede' } } } } }
        });
        const part = data?.candidates?.[0]?.content?.parts?.find((one) => one.inlineData || one.inline_data);
        const inline = part?.inlineData || part?.inline_data;
        if (typeof inline?.data !== 'string' || !inline.data || inline.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(inline.data)) throw new AiServiceError('AI_AUDIO_RESPONSE');
        const mime = inline.mimeType || inline.mime_type || '';
        const pcm = Buffer.from(inline.data, 'base64');
        if (!/^audio\/(?:L16|pcm)(?:;|$)/i.test(mime) || !pcm.length || pcm.length % 2) throw new AiServiceError('AI_AUDIO_RESPONSE');
        const sampleRate = Number(/rate=(\d+)/.exec(mime)?.[1] || 24000);
        return { audio: pcmToWav(pcm, { sampleRate }), format: 'wav', mimeType: 'audio/wav', sampleRate, channels: 1, provider: 'gemini', model: candidate.model };
      } catch (_error) { if (signal?.aborted) throw signal.reason; pool.rest(candidate.id); }
    }
    return null;
  }
  async function synthesize({ text, language = 'fr', signal, allowRemote = true } = {}) {
    const clean = (options.prepareText || speakableText)(text);
    if (!clean) throw new AiServiceError('AI_SPEECH_INPUT');
    if (signal?.aborted) throw signal.reason;
    for (const [rang, nom] of order.entries()) {
      if (signal?.aborted) throw signal.reason;
      const result = nom === 'piper' ? await viaPiper(clean, language, signal)
        : nom === 'gemini' && allowRemote ? await viaGemini(clean, signal) : null;
      if (result) return { ...result, fallback: rang > 0 };
    }
    throw new AiServiceError('AI_SPEECH_UNAVAILABLE');
  }
  return { synthesize };
}

module.exports = { createTranscriptionService, createSpeechService, pcmToWav, readPcmWav, speakableText, doubtfulTranscription, WHISPER_STOCK_PHRASES };
