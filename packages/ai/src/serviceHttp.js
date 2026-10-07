'use strict';
const { readFile } = require('node:fs/promises');

class AiServiceError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'AiServiceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function createTokenFileReader({ tokenFile, read = readFile, now = Date.now, refreshMs = 60000 } = {}) {
  let cached;
  let expires = 0;
  let loading;
  return async () => {
    if (!tokenFile) return null;
    if (now() < expires) return cached;
    if (!loading) loading = Promise.resolve().then(() => read(tokenFile, 'utf8')).then((text) => {
      cached = String(text).trim() || null;
      expires = now() + refreshMs;
      return cached;
    }, () => { throw new AiServiceError('AI_TOKEN_UNAVAILABLE'); }).finally(() => { loading = null; });
    return loading;
  };
}

// The deadline covers response body parsing, not just the HTTP headers.
async function serviceRequest(url, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, signal, headers = {}, body, rawBody, read = 'json' } = {}) {
  if (!url) throw new AiServiceError('AI_SERVICE_UNCONFIGURED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AiServiceError('AI_INVALID_TIMEOUT');
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(new AiServiceError('AI_SERVICE_TIMEOUT')), timeoutMs);
  const combined = signal ? globalThis.AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    combined.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? rawBody : JSON.stringify(body), signal: combined
    });
    if (!response.ok) throw new AiServiceError('AI_SERVICE_HTTP', response.status);
    try { return read === 'bytes' ? Buffer.from(await response.arrayBuffer()) : await response.json(); }
    catch (error) { if (combined.aborted) throw error; throw new AiServiceError('AI_SERVICE_RESPONSE'); }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (controller.signal.aborted) throw new AiServiceError('AI_SERVICE_TIMEOUT');
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError('AI_SERVICE_UNREACHABLE');
  } finally { clearTimeout(timer); }
}
const endpoint = (base, path) => base ? `${base.replace(/\/+$/, '')}${path}` : null;

module.exports = { AiServiceError, createTokenFileReader, serviceRequest, endpoint };
