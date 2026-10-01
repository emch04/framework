'use strict';

const http = require('node:http');
const {
  pcm16ToWav, createTranscriptionProviderChain, createProviderVoiceService,
  createLocalSpeech, createSherpaEngine, createWhisperHttpEngine, asVoiceProvider, asTranscriptionProvider, decodeWav, resample
} = require('../src');

function tone(rate, ms, hz = 440) {
  const n = Math.round(rate * ms / 1000);
  return Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
}
function wavOf(samples, rate) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(Math.round(s * 32767), i * 2));
  return pcm16ToWav(pcm, rate);
}

function fakeSherpa() {
  const calls = { recognizer: [], tts: [], decoded: [] };
  class OfflineRecognizer {
    constructor(config) { calls.recognizer.push(config); }
    createStream() { const s = { samples: null, rate: null, acceptWaveform({ samples, sampleRate }) { s.samples = samples; s.rate = sampleRate; } }; return s; }
    async decodeAsync(stream) { calls.decoded.push({ length: stream.samples.length, rate: stream.rate }); return { text: ' bonjour le monde ', lang: '<|fr|>' }; }
  }
  class OfflineTts {
    constructor(config) { calls.tts.push(config); }
    async generateAsync({ text, sid, speed }) { calls.lastTts = { text, sid, speed }; return { samples: tone(22050, 100), sampleRate: 22050 }; }
  }
  return { module: { OfflineRecognizer, OfflineTts }, calls };
}

describe('WAV', () => {
  test('décode du PCM16 stéréo en mono et rééchantillonne', () => {
    const left = tone(8000, 100);
    const stereo = new Float32Array(left.length * 2);
    left.forEach((s, i) => { stereo[i * 2] = s; stereo[i * 2 + 1] = s; });
    const pcm = Buffer.alloc(stereo.length * 2);
    stereo.forEach((s, i) => pcm.writeInt16LE(Math.round(s * 32767), i * 2));
    const header = pcm16ToWav(pcm, 8000);
    header.writeUInt16LE(2, 22); // 2 canaux
    const decoded = decodeWav(header);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.samples).toHaveLength(left.length);
    expect(decoded.samples[10]).toBeCloseTo(left[10], 2);
    expect(resample(decoded.samples, 8000, 16000)).toHaveLength(left.length * 2);
    expect(resample(decoded.samples, 8000, 8000)).toBe(decoded.samples);
  });
  test('refuse un fichier qui n’est pas un WAV, ou vide', () => {
    expect(() => decodeWav(Buffer.from('pas du wav'.padEnd(60)))).toThrow('INVALID_WAV');
    expect(() => decodeWav(pcm16ToWav(Buffer.alloc(2), 16000).subarray(0, 44))).toThrow('EMPTY_AUDIO');
  });
});

describe('sherpa-onnx (doublure)', () => {
  test('transcrit un WAV : rééchantillonné à 16 kHz, langue entendue nettoyée, modèle chargé une fois', async () => {
    const { module, calls } = fakeSherpa();
    const engine = createSherpaEngine({ sherpa: module, recognizerConfig: { tokens: 'x' } });
    const out = await engine.transcribe({ audio: wavOf(tone(8000, 500), 8000) });
    expect(out).toEqual({ text: 'bonjour le monde', heardLanguage: 'fr' });
    expect(calls.decoded[0]).toEqual({ length: 8000, rate: 16000 });
    await engine.transcribe({ audio: tone(16000, 100) });
    expect(calls.recognizer).toHaveLength(1);
    expect(calls.decoded[1]).toEqual({ length: 1600, rate: 16000 });
  });
  test('synthétise en WAV lisible, voix = identifiant de locuteur', async () => {
    const { module, calls } = fakeSherpa();
    const engine = createSherpaEngine({ sherpa: module, ttsConfig: { model: {} } });
    const out = await engine.synthesize({ text: 'Bonjour', voice: '3', speed: 1.2 });
    expect(calls.lastTts).toEqual({ text: 'Bonjour', sid: 3, speed: 1.2 });
    expect(out).toMatchObject({ format: 'wav', mimeType: 'audio/wav' });
    expect(decodeWav(out.audio).sampleRate).toBe(22050);
    expect(decodeWav(out.audio).samples).toHaveLength(2205);
    await expect(engine.synthesize({ text: '  ' })).rejects.toMatchObject({ code: 'EMPTY_TEXT' });
  });
  test('capacités : une moitié non configurée refuse proprement', async () => {
    const { module } = fakeSherpa();
    const onlyStt = createSherpaEngine({ sherpa: module, recognizerConfig: {} });
    expect(onlyStt.capabilities).toEqual({ transcribe: true, synthesize: false });
    await expect(onlyStt.synthesize({ text: 'a' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(() => createSherpaEngine({})).toThrow('SHERPA_CONFIG_REQUIRED');
  });
});

describe('service faster-whisper (faux serveur HTTP)', () => {
  let server;
  let seen;
  let respond;
  beforeEach(async () => {
    seen = [];
    respond = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: ' Salut ', language: 'fr', segments: [{ avg_logprob: -0.2, no_speech_prob: 0.01 }, { avg_logprob: -0.4, no_speech_prob: 0.05 }] })); };
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { seen.push({ url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('latin1') }); respond(req, res); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = () => `http://127.0.0.1:${server.address().port}`;

  test('transcription : multipart, modèle, langue, confiance moyenne', async () => {
    const engine = createWhisperHttpEngine({ baseUrl: `${url()}/v1`, apiKey: 'k' });
    const out = await engine.transcribe({ audio: wavOf(tone(16000, 100), 16000), language: 'fr' });
    expect(out.text).toBe('Salut');
    expect(out.heardLanguage).toBe('fr');
    expect(out.logprob).toBeCloseTo(-0.3, 5);
    expect(out.noSpeechProbability).toBe(0.05);
    expect(seen[0].url).toBe('/v1/audio/transcriptions');
    expect(seen[0].headers.authorization).toBe('Bearer k');
    expect(seen[0].raw).toContain('name="model"');
    expect(seen[0].raw).toContain('Systran/faster-whisper-small');
    expect(seen[0].raw).toContain('name="language"');
    expect(seen[0].raw).toContain('verbose_json');
  });
  test('synthèse : JSON de la requête et audio renvoyé tel quel', async () => {
    respond = (req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(Buffer.from('RIFFfaux')); };
    const engine = createWhisperHttpEngine({ baseUrl: url(), ttsModel: 'kokoro', ttsVoice: 'ff_siwis' });
    const out = await engine.synthesize({ text: 'Bonjour' });
    expect(Buffer.from(out.audio).toString()).toBe('RIFFfaux');
    expect(JSON.parse(seen[0].raw)).toEqual({ model: 'kokoro', input: 'Bonjour', voice: 'ff_siwis', response_format: 'wav' });
    expect(createWhisperHttpEngine({ baseUrl: url() }).capabilities.synthesize).toBe(false);
    await expect(createWhisperHttpEngine({ baseUrl: url() }).synthesize({ text: 'a' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
  test('erreur HTTP : status exposé pour le repli de la chaîne vocale', async () => {
    respond = (req, res) => { res.writeHead(429); res.end('{}'); };
    const engine = createWhisperHttpEngine({ baseUrl: url() });
    await expect(engine.transcribe({ audio: wavOf(tone(16000, 50), 16000) })).rejects.toMatchObject({ status: 429 });
    await expect(engine.transcribe({ audio: new Uint8Array(0) })).rejects.toMatchObject({ code: 'EMPTY_AUDIO' });
  });
  test('délai dépassé', async () => {
    respond = () => {};
    const engine = createWhisperHttpEngine({ baseUrl: url(), timeoutMs: 80 });
    await expect(engine.transcribe({ audio: wavOf(tone(16000, 50), 16000) })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('choix du moteur', () => {
  const whisperHttp = { baseUrl: 'http://127.0.0.1:1' };
  test('auto : sherpa quand configuré et disponible, sinon le service HTTP', () => {
    const { module } = fakeSherpa();
    expect(createLocalSpeech({ sherpa: { recognizerConfig: {} }, sherpaModule: module, whisperHttp }).engine).toBe('sherpa');
    // sherpa-onnx-node n'est pas installé ici : sans module injecté, on retombe sur HTTP.
    expect(createLocalSpeech({ sherpa: { recognizerConfig: {} }, whisperHttp }).engine).toBe('whisper-http');
    expect(createLocalSpeech({ whisperHttp }).engine).toBe('whisper-http');
  });
  test('choix explicite, et erreurs claires', () => {
    const { module } = fakeSherpa();
    expect(createLocalSpeech({ engine: 'whisper-http', whisperHttp, sherpa: { recognizerConfig: {} }, sherpaModule: module }).engine).toBe('whisper-http');
    expect(() => createLocalSpeech({ engine: 'sherpa', whisperHttp })).toThrow('SHERPA_CONFIG_REQUIRED');
    expect(() => createLocalSpeech({ engine: 'whisper-http' })).toThrow('WHISPER_HTTP_CONFIG_REQUIRED');
    expect(() => createLocalSpeech({})).toThrow('NO_LOCAL_SPEECH_ENGINE');
    expect(() => createLocalSpeech({ engine: 'piper' })).toThrow('INVALID_ENGINE');
  });
});

describe('branchement sur @astratra/voice', () => {
  test('la chaîne de transcription utilise le moteur local, avec repli sur le suivant', async () => {
    const { module } = fakeSherpa();
    const local = createSherpaEngine({ sherpa: module, recognizerConfig: {} });
    const chain = createTranscriptionProviderChain({
      providers: [asTranscriptionProvider(local), { id: 'nuage', transcribe: async () => 'ne sert pas' }],
      supportedLanguages: ['fr']
    });
    const out = await chain.transcribe(wavOf(tone(16000, 300), 16000), { language: 'fr' });
    expect(out).toMatchObject({ text: 'bonjour le monde', provider: 'sherpa-onnx', fallback: false });
  });
  test('le service de synthèse choisit la voix par langue', async () => {
    const { module, calls } = fakeSherpa();
    const local = createSherpaEngine({ sherpa: module, ttsConfig: {} });
    const service = createProviderVoiceService({ providers: [asVoiceProvider(local, { voices: { fr: 5 } })] });
    const out = await service.synthesize({ text: 'Bonjour', language: 'fr' });
    expect(out).toMatchObject({ provider: 'sherpa-onnx', format: 'wav' });
    expect(calls.lastTts.sid).toBe(5);
  });
  test('adaptateurs : refus si la capacité manque', () => {
    const { module } = fakeSherpa();
    expect(() => asVoiceProvider(createSherpaEngine({ sherpa: module, recognizerConfig: {} }))).toThrow('SYNTHESIS_NOT_CONFIGURED');
    expect(() => asTranscriptionProvider(createSherpaEngine({ sherpa: module, ttsConfig: {} }))).toThrow('TRANSCRIPTION_NOT_CONFIGURED');
  });
});
