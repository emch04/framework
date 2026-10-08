/* global AbortController */
const STATUSES = new Set(['ok', 'rejected', 'quota', 'unavailable']);
/** Only a fixed status leaves the injected probe. No provider body or error text. */
function createKeyProbe({ vault, probes, transport, timeoutMs = 10_000 } = {}) {
  if (!vault || typeof vault.get !== 'function' || !probes || typeof transport !== 'function') {
    throw new Error('A key probe requires vault, probes and an injected transport.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeoutMs.');
  return {
    async check(key) {
      if (!Object.prototype.hasOwnProperty.call(probes, key) || typeof probes[key] !== 'function') return { status: 'unavailable' };
      const controller = new AbortController();
      let timer;
      try {
        const result = await Promise.race([
          (async () => {
            const value = await vault.get(key);
            if (!value) return 'unavailable';
            return probes[key](value, { transport, signal: controller.signal });
          })(),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unavailable'); }, timeoutMs); })
        ]);
        return { status: typeof result === 'string' && STATUSES.has(result) ? result : 'unavailable' };
      } catch { return { status: 'unavailable' }; }
      finally { clearTimeout(timer); }
    }
  };
}
module.exports = { createKeyProbe };
