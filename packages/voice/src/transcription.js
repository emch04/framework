'use strict';

const { classifyProviderError } = require('./providers');

function validate(rate, ms) {
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(ms) || ms < 0) throw new RangeError('INVALID_AUDIO_RATE');
}

function appendTrailingSilence(samples, sampleRate = 16000, silenceMs = 500) {
  validate(sampleRate, silenceMs);
  const extra = Math.round(sampleRate * silenceMs / 1000);
  if (Buffer.isBuffer(samples)) {
    if (samples.length % 2) throw new RangeError('INVALID_PCM16');
    const out = Buffer.alloc(samples.length + extra * 2);
    samples.copy(out);
    return out;
  }
  const Type = samples instanceof Int16Array ? Int16Array : Float32Array;
  const out = new Type(samples.length + extra);
  out.set(samples);
  return out;
}

function confidenceFromLogProbabilities(logs = []) {
  if (!logs.length || logs.some((value) => !Number.isFinite(value))) return null;
  return Math.max(0, Math.min(1, Math.exp(logs.reduce((sum, value) => sum + value, 0) / logs.length)));
}

function analyzeTranscription(text, durationMs, options = {}) {
  const input = String(text ?? '').trim().normalize('NFC');
  const verdict = (reason) => ({ doubtful: reason !== 'ACCEPTED', reason, confidence: reason === 'ACCEPTED' ? null : options.lowConfidence ?? 0.1 });
  if (!input) return verdict('EMPTY_TEXT');
  const words = input.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  if (!words.length) return verdict('EMPTY_TEXT');
  const catalog = options.stockPhrases || options.stockPhrasesByLanguage?.[options.language] || [];
  if (catalog.some((phrase) => phrase && input.toLocaleLowerCase().includes(String(phrase).normalize('NFC').toLocaleLowerCase()))) return verdict('STOCK_PHRASE');
  if (Number.isFinite(options.logprob) && options.logprob < (options.logprobMin ?? -1)) return verdict('LOW_LOGPROB');
  if (Number.isFinite(options.noSpeechProbability) && options.noSpeechProbability > (options.noSpeechMax ?? 0.6)) return verdict('NO_SPEECH');
  if (options.expectedVocabulary) {
    const known = new Set((Array.isArray(options.expectedVocabulary) ? options.expectedVocabulary : String(options.expectedVocabulary).split(/\s+/)).map((word) => String(word).toLocaleLowerCase()));
    if (words.length >= (options.vocabularyEchoMinWords ?? 4) && words.filter((word) => known.has(word)).length / words.length >= (options.vocabularyEchoRatio ?? 0.75)) return verdict('VOCABULARY_ECHO');
  }
  const seconds = durationMs / 1000;
  if (seconds >= (options.minDurationSeconds ?? 3) && words.length / seconds < (options.minWordsPerSecond ?? 0.6)) return verdict('TOO_FEW_WORDS');
  const loopLength = options.loopLength ?? 4;
  for (let i = 0; i + loopLength <= words.length; i += 1) {
    if (words.slice(i, i + loopLength).every((word) => word === words[i])) return verdict('WORD_LOOP');
  }
  let tripleRuns = 0;
  for (let i = 0; i + 2 < words.length; i += 1) if (words[i] === words[i + 1] && words[i] === words[i + 2]) tripleRuns += 1;
  if (tripleRuns >= 2) return verdict('WORD_LOOP');
  for (let i = 0; i + 5 < words.length; i += 1) {
    if (words[i] === words[i + 2] && words[i] === words[i + 4] && words[i + 1] === words[i + 3] && words[i + 1] === words[i + 5]) return verdict('PHRASE_LOOP');
  }
  const nonWord = options.isNonWord || ((word) => !/[aeiouyàâäéèêëîïôöùûüœ]/iu.test(word) || /(.)\1\1/u.test(word));
  const alphabetic = words.filter((word) => /\p{L}/u.test(word));
  if (alphabetic.length >= 3 && alphabetic.filter(nonWord).length / alphabetic.length >= (options.nonWordRatio ?? 0.5)) return verdict('NON_WORDS');
  return verdict('ACCEPTED');
}

function isDoubtfulTranscription(text, durationMs, options = {}) { return analyzeTranscription(text, durationMs, options).doubtful; }

function toFloat(samples, format) {
  if (format !== 'pcm16' && !(samples instanceof Int16Array) && !Buffer.isBuffer(samples)) return Float32Array.from(samples);
  if (Buffer.isBuffer(samples)) {
    if (samples.length % 2) throw new RangeError('INVALID_PCM16');
    return Float32Array.from({ length: samples.length / 2 }, (_, i) => samples.readInt16LE(i * 2) / 32768);
  }
  return Float32Array.from(samples, (sample) => sample / 32768);
}

function createLocalTranscriber({ transcribe, sampleRate = 16000, silenceMs = 500, inputFormat = 'float32', doubtfulOptions = {}, lowConfidence = 0.1 }) {
  if (typeof transcribe !== 'function') throw new TypeError('TRANSCRIBE_REQUIRED');
  validate(sampleRate, silenceMs);
  return {
    async transcribe(samples, options = {}) {
      const audio = toFloat(samples, inputFormat);
      const decoded = await transcribe(appendTrailingSilence(audio, sampleRate, silenceMs), options);
      const item = typeof decoded === 'string' ? { text: decoded } : decoded || {};
      const text = String(item.text ?? '').trim();
      const durationMs = audio.length * 1000 / sampleRate;
      const assessment = analyzeTranscription(text, durationMs, {
        ...doubtfulOptions,
        language: options.language ?? doubtfulOptions.language,
        logprob: item.logprob ?? doubtfulOptions.logprob,
        noSpeechProbability: item.noSpeechProbability ?? doubtfulOptions.noSpeechProbability,
        lowConfidence
      });
      return { text, durationMs, doubtful: assessment.doubtful, reason: assessment.reason, confidence: assessment.doubtful ? lowConfidence : (item.confidence ?? null) };
    }
  };
}

function createTranscriptionProviderChain({ providers = [], supportedLanguages = [] } = {}) {
  return {
    async transcribe(audio, options = {}) {
      const attempts = [];
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        if (!provider || typeof provider.transcribe !== 'function') continue;
        const providerId = provider.id || `provider_${index}`;
        try {
          /* `requestedLanguage` tells a provider that cannot listen freely (or hears no language) what the caller asked for. */
          let decoded = await provider.transcribe({ ...options, audio, language: null, requestedLanguage: options.language ?? null });
          if (typeof decoded === 'string') decoded = { text: decoded };
          const heard = decoded?.heardLanguage ?? null;
          if (options.language && (!heard || (supportedLanguages.length && !supportedLanguages.includes(heard)))) {
            decoded = await provider.transcribe({ ...options, audio, language: options.language, requestedLanguage: options.language });
            if (typeof decoded === 'string') decoded = { text: decoded };
          }
          const text = String(decoded?.text ?? '').trim();
          if (!text) throw Object.assign(new Error('EMPTY_TRANSCRIPT'), { code: 'EMPTY_TRANSCRIPT' });
          return { text, heardLanguage: decoded?.heardLanguage ?? options.language ?? null, provider: providerId, fallback: index > 0, attempts };
        } catch (error) {
          attempts.push({ provider: providerId, code: classifyProviderError(error) });
        }
      }
      throw Object.assign(new Error('TRANSCRIPTION_UNAVAILABLE'), { code: 'TRANSCRIPTION_UNAVAILABLE', attempts });
    }
  };
}

module.exports = { appendTrailingSilence, confidenceFromLogProbabilities, analyzeTranscription, isDoubtfulTranscription, createLocalTranscriber, createTranscriptionProviderChain };
