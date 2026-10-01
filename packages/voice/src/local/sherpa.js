'use strict';

const { pcm16ToWav } = require('../providers');
const { decodeWav, resample, floatToPcm16 } = require('./wav');

function loadSherpa() {
  try {
    return require('sherpa-onnx-node');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw Object.assign(new Error('sherpa-onnx-node est requis : npm install sherpa-onnx-node'), { code: 'SHERPA_MISSING' });
    }
    throw error;
  }
}

/**
 * Moteur sherpa-onnx (Apache-2.0), tout en local sur CPU. Les configurations
 * `recognizerConfig` (OfflineRecognizer) et `ttsConfig` (OfflineTts) sont celles
 * de sherpa-onnx, avec les chemins de TES modèles : ce paquet n'en fournit aucun.
 * Les modèles sont chargés à la première utilisation (plusieurs secondes), pas
 * à la création.
 */
function createSherpaEngine({ sherpa, recognizerConfig, ttsConfig, sampleRate = 16000, id = 'sherpa-onnx' } = {}) {
  if (!recognizerConfig && !ttsConfig) throw new TypeError('SHERPA_CONFIG_REQUIRED');
  let recognizer = null;
  let tts = null;
  const module_ = () => sherpa || loadSherpa();

  async function transcribe({ audio, language = null, requestedLanguage = null } = {}) {
    if (!recognizerConfig) throw Object.assign(new Error('TRANSCRIPTION_NOT_CONFIGURED'), { code: 'NOT_CONFIGURED' });
    let samples;
    let rate = sampleRate;
    if (audio instanceof Float32Array) {
      samples = audio;
    } else {
      const decoded = decodeWav(audio);
      samples = resample(decoded.samples, decoded.sampleRate, sampleRate);
      rate = sampleRate;
    }
    recognizer ||= new (module_().OfflineRecognizer)(recognizerConfig);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: rate, samples });
    // Décodage asynchrone : le calcul CPU ne bloque pas la boucle d'événements du serveur.
    const result = (await recognizer.decodeAsync(stream)) || {};
    return { text: String(result.text ?? '').trim(), heardLanguage: result.lang ? String(result.lang).replace(/[<|>]/g, '') : (language ?? requestedLanguage ?? null) };
  }

  async function synthesize({ text, voice = null, speed = 1 } = {}) {
    if (!ttsConfig) throw Object.assign(new Error('SYNTHESIS_NOT_CONFIGURED'), { code: 'NOT_CONFIGURED' });
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('EMPTY_TEXT'), { code: 'EMPTY_TEXT' });
    tts ||= new (module_().OfflineTts)(ttsConfig);
    const sid = Number.isInteger(Number(voice)) && voice !== null ? Number(voice) : 0;
    const generated = await tts.generateAsync({ text, sid, speed });
    if (!generated?.samples?.length) throw Object.assign(new Error('EMPTY_AUDIO'), { code: 'EMPTY_AUDIO' });
    const wav = pcm16ToWav(floatToPcm16(generated.samples), generated.sampleRate);
    return { audio: wav, format: 'wav', mimeType: 'audio/wav' };
  }

  return {
    id,
    engine: 'sherpa',
    capabilities: { transcribe: Boolean(recognizerConfig), synthesize: Boolean(ttsConfig) },
    transcribe,
    synthesize,
    close() { recognizer = null; tts = null; }
  };
}

module.exports = { createSherpaEngine, loadSherpa };
