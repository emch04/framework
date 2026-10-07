const { createTranscriptionService, createSpeechService, createLocalModelsClient, pcmToWav, readPcmWav, doubtfulTranscription, speakableText, createServiceLanguageDetector } = require('../src');
const { httpFixture, json } = require('./httpFixture');
let fixture;
let handle;
const pcm = () => Buffer.alloc(6400, 1);
beforeEach(async () => { handle = ({ res }) => json(res, {}); fixture = await httpFixture((args) => handle(args)); });
afterEach(async () => { await fixture?.close(); });
const transcriber = (extra = {}) => createTranscriptionService({ local: createLocalModelsClient({ baseUrl: fixture.url }), groq: { url: fixture.url + '/groq', keys: ['fake-groq'], models: ['whisper'] }, cloudflare: { url: fixture.url + '/cloudflare', keys: ['fake-cf'] }, ...extra });
/* Ces scénarios testent le repli Piper puis Gemini : l'ordre est donc donné explicitement. */
const speaker = (extra = {}) => createSpeechService({ order: ['piper', 'gemini'], piper: { baseUrl: fixture.url }, gemini: { endpoint: fixture.url, keys: ['fake-gemini'], models: ['tts'] }, ...extra });
const whisper = (res, extra = {}) => json(res, { texte: 'Bonjour Ada', langue: 'fr', logprob: -0.1, sans_parole: 0.01, duree_ms: 200, ...extra });

test('Whisper local is first, with exact PCM and vocabulary; no remote call', async () => {
  handle = ({ res }) => whisper(res);
  const result = await transcriber().transcribe({ audio: pcm(), vocabulary: 'Ada' });
  expect(result).toMatchObject({ text: 'Bonjour Ada', language: 'fr', provider: 'local', fallback: false });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0].body).toMatchObject({ audio: pcm().toString('base64'), langue: 'fr', vocabulaire: 'Ada' });
});

test('local outage falls back to Groq with a real WAV multipart file and model', async () => {
  handle = ({ res, req }) => req.url === '/transcrire' ? json(res, {}, 503) : json(res, { text: 'recognized', language: 'en' });
  const result = await transcriber().transcribe({ audio: pcm(), language: 'en' });
  expect(result).toMatchObject({ text: 'recognized', provider: 'groq', fallback: true });
  const sent = fixture.requests[1];
  expect(sent.headers['content-type']).toContain('multipart/form-data');
  expect(sent.raw.toString()).toContain('name="model"');
  expect(sent.raw.includes(Buffer.from('RIFF'))).toBe(true);
});

test('Groq quota failure goes to Cloudflare with raw base64, success:false is refused', async () => {
  handle = ({ res, req }) => req.url === '/cloudflare' ? json(res, { success: true, result: { text: 'cloud', language: 'fr' } }) : json(res, {}, 429);
  const result = await transcriber().transcribe({ audio: pcm() });
  expect(result.provider).toBe('cloudflare');
  expect(fixture.requests.map((r) => r.path)).toEqual(['/transcrire', '/groq', '/cloudflare']);
  expect(fixture.requests[2].body).toEqual({ audio: pcmToWav(pcm()).toString('base64') });
  handle = ({ res }) => json(res, { success: false, result: { text: 'false success' } });
  await expect(transcriber({ local: createLocalModelsClient(), groq: {} }).transcribe({ audio: pcm() })).rejects.toMatchObject({ code: 'AI_TRANSCRIPTION_UNAVAILABLE' });
});

test('compressed audio skips PCM-only local service; missing language stays null', async () => {
  handle = ({ res }) => json(res, { text: 'file' });
  const result = await transcriber().transcribe({ audio: Buffer.from('compressed audio'), format: 'file', filename: 'audio.m4a', mimeType: 'audio/mp4' });
  expect(result).toMatchObject({ provider: 'groq', language: null });
  expect(fixture.requests[0].path).toBe('/groq');
});

test('silence stops locally; low confidence and hallucinations fall back', async () => {
  handle = ({ res }) => whisper(res, { sans_parole: 0.9, texte: 'invented' });
  expect(await transcriber().transcribe({ audio: pcm() })).toMatchObject({ text: '', noSpeech: true, provider: 'local' });
  expect(fixture.requests).toHaveLength(1);
  handle = ({ res, req }) => req.url === '/transcrire' ? whisper(res, { texte: "Merci d'avoir regardé", logprob: -2 }) : json(res, { text: 'proper phrase' });
  expect((await transcriber().transcribe({ audio: pcm() })).provider).toBe('groq');
  expect(doubtfulTranscription('one two one two one two')).toBe(true);
});

test('local-only privacy option never sends audio outside; cancellation stops the chain', async () => {
  handle = ({ res }) => json(res, {}, 500);
  await expect(transcriber().transcribe({ audio: pcm(), allowRemote: false })).rejects.toMatchObject({ code: 'AI_TRANSCRIPTION_UNAVAILABLE' });
  expect(fixture.requests).toHaveLength(1);
  const controller = new globalThis.AbortController(); controller.abort(new Error('left'));
  await expect(transcriber().transcribe({ audio: pcm(), signal: controller.signal })).rejects.toThrow('left');
  expect(fixture.requests).toHaveLength(1);
});

test('transcription keys rotate after failure, rests skip failed keys, deadlines fall back', async () => {
  handle = ({ res, req }) => req.headers.authorization === 'Bearer fake-first' ? json(res, {}, 429) : json(res, { text: 'ok' });
  const service = transcriber({ local: createLocalModelsClient(), groq: { url: fixture.url + '/groq', keys: ['fake-first', 'fake-second'], models: ['whisper'] } });
  await service.transcribe({ audio: pcm() }); await service.transcribe({ audio: pcm() });
  expect(fixture.requests.map((r) => r.headers.authorization)).toEqual(['Bearer fake-first', 'Bearer fake-second', 'Bearer fake-second']);
  handle = ({ req, res }) => { if (req.url === '/cloudflare') json(res, { result: { text: 'deadline fallback' } }); };
  const timed = transcriber({ local: createLocalModelsClient(), groq: { url: fixture.url + '/groq', keys: ['fake'], models: ['whisper'], timeoutMs: 10 } });
  expect((await timed.transcribe({ audio: pcm() })).provider).toBe('cloudflare');
});

test('Piper first, speech text cleaned, binary WAV preserved', async () => {
  const wav = pcmToWav(pcm(), { sampleRate: 22050 });
  handle = ({ res }) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); };
  const result = await speaker().synthesize({ text: '# Hello **Ada** 😀', language: 'en' });
  expect(result).toMatchObject({ provider: 'piper', fallback: false, sampleRate: 22050, format: 'wav' });
  expect(result.audio).toEqual(wav);
  expect(fixture.requests[0].body).toEqual({ text: 'Hello Ada', lang: 'en' });
  expect(speakableText('**hello**')).toBe('hello');
});

function geminiAudio(res) { json(res, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm().toString('base64') } }] } }] }); }

test('by default Gemini speaks first, Piper only when Gemini fails', async () => {
  const wav = pcmToWav(pcm(), { sampleRate: 22050 });
  handle = ({ req, res }) => req.url === '/tts' ? (res.writeHead(200, { 'content-type': 'audio/wav' }), res.end(wav)) : geminiAudio(res);
  const both = createSpeechService({ piper: { baseUrl: fixture.url }, gemini: { endpoint: fixture.url, keys: ['fake-gemini'], models: ['tts'] } });
  expect(await both.synthesize({ text: 'bonjour' })).toMatchObject({ provider: 'gemini', fallback: false });
  expect(fixture.requests.map((r) => r.path)).toEqual(['/tts:generateContent']);
  handle = ({ req, res }) => req.url === '/tts' ? (res.writeHead(200, { 'content-type': 'audio/wav' }), res.end(wav)) : json(res, {}, 503);
  expect(await both.synthesize({ text: 'bonjour' })).toMatchObject({ provider: 'piper', fallback: true });
  expect(await both.synthesize({ text: 'bonjour', allowRemote: false })).toMatchObject({ provider: 'piper', fallback: true });
});

test('Piper failure falls back to Gemini TTS with Aoede and converts PCM to valid WAV', async () => {
  handle = ({ req, res }) => req.url === '/tts' ? json(res, {}, 503) : geminiAudio(res);
  const result = await speaker().synthesize({ text: 'hello' });
  expect(result).toMatchObject({ provider: 'gemini', model: 'tts', fallback: true, sampleRate: 24000 });
  expect(readPcmWav(result.audio).pcm).toEqual(pcm());
  expect(fixture.requests[1].body.generationConfig).toEqual({ responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } });
});

test('malformed Piper WAV falls back, rotating Gemini keys retry and local rests are observed', async () => {
  handle = ({ req, res }) => {
    if (req.url === '/tts') { res.writeHead(200); res.end('not wav'); }
    else if (req.headers['x-goog-api-key'] === 'fake-first') json(res, {}, 429);
    else geminiAudio(res);
  };
  const service = speaker({ gemini: { endpoint: fixture.url, models: ['tts'], keys: ['fake-first', 'fake-second'] } });
  await service.synthesize({ text: 'hello' }); await service.synthesize({ text: 'again' });
  expect(fixture.requests.map((r) => r.path)).toEqual(['/tts', '/tts:generateContent', '/tts:generateContent', '/tts:generateContent']);
  expect(fixture.requests[3].headers['x-goog-api-key']).toBe('fake-second');
});

test('empty text, invalid PCM, malformed Gemini audio, outages and local-only produce clean codes', async () => {
  await expect(speaker().synthesize({ text: '' })).rejects.toMatchObject({ code: 'AI_SPEECH_INPUT' });
  expect(() => pcmToWav(Buffer.alloc(1))).toThrow('AI_AUDIO_INPUT');
  expect(() => readPcmWav(Buffer.alloc(44))).toThrow('AI_AUDIO_RESPONSE');
  await expect(transcriber().transcribe({ audio: Buffer.alloc(1) })).rejects.toMatchObject({ code: 'AI_AUDIO_INPUT' });
  handle = ({ res }) => json(res, {});
  await expect(speaker().synthesize({ text: 'hello' })).rejects.toMatchObject({ code: 'AI_SPEECH_UNAVAILABLE' });
  await expect(speaker().synthesize({ text: 'hello', allowRemote: false })).rejects.toMatchObject({ code: 'AI_SPEECH_UNAVAILABLE' });
});

test('fastText service wins above confidence threshold; heuristic and app fallback on outage', async () => {
  handle = ({ res, body }) => json(res, { lang: body.text === 'ok' ? 'en' : 'es', confidence: body.text === 'ok' ? 0.6 : 0.99 });
  const language = createServiceLanguageDetector({ baseUrl: fixture.url });
  expect(await language.reply('bonjour tous', 'fr')).toBe('es');
  expect(await language.reply('ok', 'fr')).toBe('fr');
  handle = ({ res }) => json(res, {}, 500);
  expect(await language.reply('the text is for you', 'fr')).toBe('en');
  expect(await language.reply('hola gracias', 'en')).toBe('es');
  expect(await language.reply('?', 'en')).toBe('en');
  expect(await createServiceLanguageDetector().reply('merci', 'en')).toBe('fr');
});

test('language timeout and unsupported/malformed confidence keep the heuristic', async () => {
  handle = () => {};
  const language = createServiceLanguageDetector({ baseUrl: fixture.url, timeoutMs: 10 });
  expect(await language.reply('bonjour', 'en')).toBe('fr');
  handle = ({ res }) => json(res, { lang: 'und', confidence: 1 });
  expect(await language.reply('hello', 'fr')).toBe('en');
  handle = ({ res }) => json(res, { lang: 'es', confidence: '1' });
  expect(await language.reply('hello', 'fr')).toBe('en');
});

test('one missing Piper language does not disable another language', async () => {
  handle = ({ req, res, body }) => {
    if (req.url !== '/tts') return geminiAudio(res);
    if (body.lang === 'es') json(res, {}, 503);
    else { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(pcmToWav(pcm())); }
  };
  const service = speaker();
  expect((await service.synthesize({ text: 'hola', language: 'es' })).provider).toBe('gemini');
  expect((await service.synthesize({ text: 'bonjour', language: 'fr' })).provider).toBe('piper');
});

test('speech deadlines fall back and abort prevents further providers', async () => {
  handle = ({ req, res }) => { if (req.url !== '/tts') geminiAudio(res); };
  const service = speaker({ piper: { baseUrl: fixture.url, timeoutMs: 10 } });
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('gemini');
  const controller = new globalThis.AbortController(); controller.abort(new Error('left'));
  await expect(service.synthesize({ text: 'hello', signal: controller.signal })).rejects.toThrow('left');
  expect(fixture.requests).toHaveLength(2);
});
