'use strict';

const { createSherpaEngine, loadSherpa } = require('./sherpa');
const { createWhisperHttpEngine } = require('./whisperHttp');
const { decodeWav, resample } = require('./wav');

function sherpaAvailable() {
  try {
    loadSherpa();
    return true;
  } catch {
    return false;
  }
}

/**
 * Choix du moteur. `engine` : 'sherpa', 'whisper-http' ou 'auto'.
 * Auto : sherpa si sa configuration est donnée ET que le module est installé,
 * sinon le service HTTP s'il est configuré, sinon erreur claire. `sherpa`
 * (le module) peut être injecté, ce qui sert aux tests et aux binaires embarqués.
 */
function createLocalSpeech({ engine = 'auto', sherpa, whisperHttp, sherpaModule } = {}) {
  if (!['auto', 'sherpa', 'whisper-http'].includes(engine)) throw new RangeError('INVALID_ENGINE');
  const usable = sherpa && (sherpaModule || sherpaAvailable());
  if (engine === 'sherpa' || (engine === 'auto' && usable)) {
    if (!sherpa) throw new TypeError('SHERPA_CONFIG_REQUIRED');
    return createSherpaEngine({ ...sherpa, sherpa: sherpaModule });
  }
  if (engine === 'whisper-http' || (engine === 'auto' && whisperHttp)) {
    if (!whisperHttp) throw new TypeError('WHISPER_HTTP_CONFIG_REQUIRED');
    return createWhisperHttpEngine(whisperHttp);
  }
  throw Object.assign(new Error('NO_LOCAL_SPEECH_ENGINE: configure sherpa (et installe sherpa-onnx-node) ou whisperHttp'), { code: 'NO_LOCAL_SPEECH_ENGINE' });
}

/** Fournisseur de synthèse au format de createProviderVoiceService (@astratra/voice). */
function asVoiceProvider(speech, { voices = {}, defaultVoice = null } = {}) {
  if (!speech.capabilities.synthesize) throw new TypeError('SYNTHESIS_NOT_CONFIGURED');
  return {
    id: speech.id,
    synthesize: ({ text, language, voice }) => speech.synthesize({ text, voice: voice ?? voices[language] ?? defaultVoice })
  };
}

/** Fournisseur de transcription au format de createTranscriptionProviderChain (@astratra/voice). */
function asTranscriptionProvider(speech) {
  if (!speech.capabilities.transcribe) throw new TypeError('TRANSCRIPTION_NOT_CONFIGURED');
  return { id: speech.id, transcribe: (request) => speech.transcribe(request) };
}

module.exports = { createLocalSpeech, createSherpaEngine, createWhisperHttpEngine, asVoiceProvider, asTranscriptionProvider, loadSherpa, decodeWav, resample };
