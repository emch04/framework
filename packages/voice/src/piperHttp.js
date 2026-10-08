'use strict';

const { classifyProviderError } = require('./providers');
const { abortError, combineSignals } = require('./abort');

const DEFAULT_FORMATS = { wav: 'audio/wav', 'x-wav': 'audio/wav', mp4: 'audio/mp4', m4a: 'audio/mp4', aac: 'audio/mp4' };

function formatOf(contentType) {
  const subtype = /^audio\/([\w.+-]+)/i.exec(String(contentType || ''))?.[1]?.toLowerCase();
  if (!subtype || !DEFAULT_FORMATS[subtype]) return { format: 'wav', mimeType: 'audio/wav' };
  const mimeType = DEFAULT_FORMATS[subtype];
  return { format: mimeType === 'audio/mp4' ? 'm4a' : 'wav', mimeType };
}

/**
 * A voice provider that speaks to a Piper HTTP service (a local `/tts`
 * endpoint): `POST {url}/tts` with `{ text, lang }` as JSON, an optional bearer
 * token, audio in the answer. It plugs into createProviderVoiceService next to
 * (or instead of) the command-line Piper of createVoiceService.
 *
 * The token is `token` (a string, or a function returning one) or, read afresh
 * at every request so a rotation needs no restart, the content of `tokenFile`
 * (read with `readFile`, default `node:fs/promises`). Without either, no
 * Authorization header is sent.
 *
 * A caller's `signal` cancels the request; the timeout (`timeoutMs`, 30 s)
 * counts as a transient failure, a cancellation as an abort.
 */
function createPiperHttpProvider(options = {}) {
  const baseUrl = String(options.url || '').replace(/\/+$/, '');
  if (!baseUrl) throw new TypeError('createPiperHttpProvider: url is required.');
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch (_error) {
    throw new TypeError('createPiperHttpProvider: url must be an http(s) address.');
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createPiperHttpProvider: fetch is required.');
  const route = options.path === undefined ? '/tts' : String(options.path);
  const timeoutMs = options.timeoutMs ?? 30000;
  const defaultLanguage = options.defaultLanguage;
  const readFile = options.readFile || ((file, encoding) => require('node:fs/promises').readFile(file, encoding));
  if (options.token !== undefined && options.tokenFile !== undefined) throw new TypeError('createPiperHttpProvider: give token or tokenFile, not both.');

  async function tokenOf() {
    if (options.token !== undefined) return String(typeof options.token === 'function' ? await options.token() : options.token).trim();
    if (options.tokenFile) return String(await readFile(options.tokenFile, 'utf8')).trim();
    return '';
  }

  return {
    id: options.id || 'piper-http',
    voice: options.voice,
    async synthesize(request = {}) {
      const { text, voice, signal } = request;
      const language = request.language === 'auto' && defaultLanguage ? defaultLanguage : request.language;
      if (signal && signal.aborted) throw abortError(signal);
      let token;
      try { token = await tokenOf(); } catch (error) { throw Object.assign(new Error('PIPER_TOKEN_UNREADABLE'), { code: 'AUTH', cause: error }); }
      if (signal && signal.aborted) throw abortError(signal);
      const body = options.buildBody
        ? options.buildBody({ text, language, voice })
        : { text, lang: language, ...(voice ? { voice } : {}) };
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${route}`, {
          method: 'POST',
          signal: combineSignals([signal], timeoutMs),
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body)
        });
      } catch (error) {
        if (signal && signal.aborted) throw abortError(signal);
        if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw Object.assign(new Error('PIPER_TIMEOUT'), { code: 'TRANSIENT' });
        throw error;
      }
      if (!response.ok) throw Object.assign(new Error('PIPER_HTTP_ERROR'), { status: response.status, code: classifyProviderError({ status: response.status }) });
      let audio;
      try {
        audio = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (signal && signal.aborted) throw abortError(signal);
        throw error;
      }
      const type = formatOf(typeof response.headers?.get === 'function' ? response.headers.get('content-type') : '');
      return { audio, ...type };
    }
  };
}

module.exports = { createPiperHttpProvider };
