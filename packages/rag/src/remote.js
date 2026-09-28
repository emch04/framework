class EmbedderUnavailableError extends Error { constructor() { super('EMBEDDER_UNAVAILABLE'); this.code = 'EMBEDDER_UNAVAILABLE'; } }
function createRemoteEmbedder({ url, modelId, fetch, headers = {}, timeoutMs = 120_000, retries = 2, retryDelayMs = 250, jitter = 0.2, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, createAbortController = () => new globalThis.AbortController(), maxTexts = 64, maxTextLength = 8_000, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), circuitBreaker, logger, maskText } = {}) {
  if (!url || !modelId || typeof fetch !== 'function' || !Number.isInteger(retries) || retries < 0 || timeoutMs <= 0) throw new TypeError('INVALID_REMOTE_EMBEDDER');
  if (typeof maskText !== 'function') throw new TypeError('MASK_REQUIRED');
  async function request(texts, { kind }) {
    if (!Array.isArray(texts) || !texts.length || texts.length > maxTexts || texts.some((text) => typeof text !== 'string')) throw new TypeError('INVALID_REMOTE_BATCH');
    const safe = await Promise.all(texts.map((text) => maskText(text, { kind, modelId })));
    if (safe.some((text) => typeof text !== 'string' || text.length > maxTextLength)) throw new TypeError('INVALID_MASKED_TEXT');
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = createAbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimer(() => { controller.abort(); reject(new Error('REMOTE_TIMEOUT')); }, timeoutMs); });
        const perform = async () => {
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ texts: safe, kind, modelId }), signal: controller.signal });
          if (!response.ok) {
            if (response.status < 500 && response.status !== 429) throw Object.assign(new Error('REMOTE_REJECTED'), { retryable: false });
            throw new Error('REMOTE_UNAVAILABLE');
          }
          return response.json();
        };
        const payload = await Promise.race([circuitBreaker?.call ? circuitBreaker.call(perform) : perform(), timeout]);
        if (payload.modelId !== modelId || !Array.isArray(payload.vectors) || payload.vectors.length !== texts.length || payload.vectors.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((n) => !Number.isFinite(n)))) throw Object.assign(new Error('INVALID_REMOTE_RESPONSE'), { retryable: false });
        return payload.vectors;
      } catch (error) {
        lastError = error;
        if (error.retryable === false || attempt === retries || circuitBreaker?.isOpen?.()) break;
        const ms = Math.max(0, retryDelayMs * (2 ** attempt) * (1 + (random() * 2 - 1) * jitter));
        logger?.warn?.({ code: 'REMOTE_RETRY', attempt: attempt + 1 });
        await delay(ms);
      } finally { if (timer !== undefined) clearTimer(timer); }
    }
    if (lastError?.retryable === false) throw lastError;
    throw new EmbedderUnavailableError();
  }
  return { modelId, embed: request };
}
module.exports = { createRemoteEmbedder, EmbedderUnavailableError };
