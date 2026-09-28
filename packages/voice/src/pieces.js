'use strict';

function splitSpeechPieces(text, { maxChars = 600 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('INVALID_PIECE_SIZE');
  const input = String(text ?? '').trim().replace(/\s+/gu, ' ');
  if (!input) return [];
  const sentences = input.match(/[^.!?…]+[.!?…]*|[.!?…]+/gu) || [];
  const pieces = [];
  let current = '';
  const release = () => { if (current) pieces.push(current); current = ''; };
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) {
      const joined = current ? `${current} ${sentence}` : sentence;
      if (joined.length > maxChars) release();
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }
    release();
    for (const word of sentence.split(' ')) {
      const joined = current ? `${current} ${word}` : word;
      if (joined.length > maxChars && current) release();
      current = current ? `${current} ${word}` : word;
      while (current.length > maxChars) { pieces.push(current.slice(0, maxChars)); current = current.slice(maxChars); }
    }
  }
  release();
  return pieces;
}

/** A whole reading keeps one provider; active pieces settle before fallback. */
function createPieceVoiceService({ providers = [], maxConcurrent = 3 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('INVALID_CONCURRENCY');
  return {
    async synthesize(input, request = {}) {
      const texts = Array.isArray(input) ? input : splitSpeechPieces(input, request);
      if (!texts.length) throw Object.assign(new Error('TEXT_REQUIRED'), { code: 'TEXT_REQUIRED' });
      const attempts = [];
      for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
        const provider = providers[providerIndex];
        if (!provider || typeof provider.synthesize !== 'function') continue;
        const pieces = new Array(texts.length);
        let next = 0;
        let failed = false;
        const workers = Array.from({ length: Math.min(maxConcurrent, texts.length) }, async () => {
          while (!failed && next < texts.length) {
            const index = next++;
            try { pieces[index] = await provider.synthesize({ ...request, text: texts[index], index }); }
            catch (_error) { failed = true; }
          }
        });
        await Promise.all(workers);
        if (!failed) return { pieces, provider: provider.id || `provider_${providerIndex}`, fallback: providerIndex > 0, attempts };
        attempts.push({ provider: provider.id || `provider_${providerIndex}`, code: 'PIECE_FAILED' });
      }
      throw Object.assign(new Error('PROVIDERS_UNAVAILABLE'), { code: 'PROVIDERS_UNAVAILABLE', attempts });
    }
  };
}

module.exports = { splitSpeechPieces, createPieceVoiceService };
