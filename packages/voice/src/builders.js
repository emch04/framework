'use strict';

/* Changing a model, speaker, pause, intonation, or finishing filter changes
   the bytes. The version belongs in every cache key so old audio can never be
   mistaken for the current voice after such a change. */
const VOICE_VERSION = 'v2';

/* These three equalizers are deliberately explicit. A broad "voice" preset
   hid the real regression: warmth at 160 Hz, consonant presence at 3 kHz and
   Piper's metallic edge at 8 kHz had to remain independently reviewable. */
const VOICE_FILTER = [
  'equalizer=f=160:t=q:w=0.9:g=2',
  'equalizer=f=3000:t=q:w=1.3:g=2',
  'equalizer=f=8000:t=q:w=1.5:g=-2.5',
  'highpass=f=70',
  'deesser=i=0.3',
  'acompressor=threshold=-20dB:ratio=2.5:attack=5:release=80',
  'loudnorm=I=-16:TP=-1.5:LRA=11'
].join(',');

function buildFfmpegArgs(inputPath, outputPath, options = {}) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-af', options.filter || VOICE_FILTER,
    '-ac', String(options.channels ?? 1),
    '-ar', String(options.sampleRate ?? 24000),
    '-c:a', options.codec || 'aac',
    '-b:a', options.bitrate || '64k',
    '-movflags', '+faststart',
    outputPath
  ];
}

function normalizeLanguage(language, fallback = 'default') {
  const value = String(language || '').trim().toLowerCase().replace('_', '-');
  return value ? value.split('-')[0] : fallback;
}

function buildPiperArgs(options = {}) {
  if (!options.modelPath) throw new Error('buildPiperArgs: modelPath is required.');
  if (!options.outputPath) throw new Error('buildPiperArgs: outputPath is required.');
  const language = normalizeLanguage(options.language);
  const speakers = options.speakers || {};
  const speaker = options.speaker ?? speakers[language];
  const args = [
    '--model', options.modelPath,
    '--output_file', options.outputPath,
    '--length_scale', String(options.lengthScale ?? 0.92),
    '--sentence_silence', String(options.sentenceSilence ?? 0.35),
    /* The persistent server and CLI must share these values. Otherwise a
       fallback changes intonation mid-session even though the model did not. */
    '--noise_scale', String(options.noiseScale ?? 0.73),
    '--noise_w', String(options.noiseW ?? 0.92)
  ];
  if (speaker !== undefined && speaker !== null && speaker !== '') {
    args.push('--speaker', String(speaker));
  }
  return args;
}

/* cyrb53 is pure JavaScript. A Node crypto digest made server keys easy but
   forced mobile callers to copy the rule, which is exactly how voice versions
   drifted between the two caches. Two seeds provide a file-safe 106-bit key. */
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (2097152 * (h2 >>> 0) + (h1 >>> 0)).toString(36);
}

function voiceCacheSource(text, options = {}) {
  const version = String(options.version || VOICE_VERSION);
  const language = normalizeLanguage(options.language, 'auto');
  /* JSON preserves boundaries: text "b:c" in language "a" must not collide
     with text "c" in language "a:b" because a separator was ambiguous. */
  return JSON.stringify([version, language, String(text ?? '')]);
}

function buildVoiceCacheKey(text, options = {}) {
  const source = voiceCacheSource(text, options);
  return `${cyrb53(source, 1)}-${cyrb53(source, 2)}`;
}

function mimeTypeForAudio(pathOrExtension) {
  const value = String(pathOrExtension || '').toLowerCase();
  return value.endsWith('.m4a') || value === 'm4a' ? 'audio/mp4' : 'audio/wav';
}

module.exports = {
  VOICE_FILTER,
  VOICE_VERSION,
  buildFfmpegArgs,
  buildPiperArgs,
  buildVoiceCacheKey,
  mimeTypeForAudio,
  normalizeLanguage,
  voiceCacheSource
};
