const { createTranscriptionProviderChain } = require('../src');

test('first transcriber returns detected language', async () => {
  const chain = createTranscriptionProviderChain({ providers: [{ id: 'one', transcribe: async () => ({ text: 'hello', heardLanguage: 'en' }) }], supportedLanguages: ['en'] });
  expect(await chain.transcribe(Buffer.from([1]), { language: 'fr' })).toMatchObject({ text: 'hello', heardLanguage: 'en', provider: 'one', fallback: false });
});
test('unknown detected language triggers a retry in requested language', async () => {
  const calls = [];
  const chain = createTranscriptionProviderChain({ providers: [{ id: 'one', transcribe: async ({ language }) => { calls.push(language); return { text: language ? 'bonjour' : 'uncertain', heardLanguage: null }; } }], supportedLanguages: ['en', 'fr'] });
  expect((await chain.transcribe(Buffer.from([1]), { language: 'fr' })).text).toBe('bonjour');
  expect(calls).toEqual([null, 'fr']);
});
test('no requested language avoids a second decoding', async () => {
  let calls = 0;
  const chain = createTranscriptionProviderChain({ providers: [{ id: 'one', transcribe: async () => { calls++; return 'hello'; } }] });
  await chain.transcribe(Buffer.from([1]));
  expect(calls).toBe(1);
});
test('failed primary falls back to next provider', async () => {
  const chain = createTranscriptionProviderChain({ providers: [
    { id: 'one', transcribe: async () => { throw new Error(); } },
    { id: 'two', transcribe: async () => ({ text: 'hello' }) }
  ] });
  expect(await chain.transcribe(Buffer.from([1]))).toMatchObject({ provider: 'two', fallback: true, text: 'hello' });
});
test('empty primary transcript falls back', async () => {
  const chain = createTranscriptionProviderChain({ providers: [
    { id: 'one', transcribe: async () => ({ text: ' ' }) },
    { id: 'two', transcribe: async () => ({ text: 'heard' }) }
  ] });
  expect((await chain.transcribe(Buffer.from([1]))).provider).toBe('two');
});
test('provider failures return codes without provider error text', async () => {
  const chain = createTranscriptionProviderChain({ providers: [{ id: 'one', transcribe: async () => { throw new Error('private detail'); } }] });
  await expect(chain.transcribe(Buffer.from([1]))).rejects.toMatchObject({ code: 'TRANSCRIPTION_UNAVAILABLE', attempts: [{ provider: 'one', code: 'PROVIDER_ERROR' }] });
});
test('retry failure moves to another provider', async () => {
  const chain = createTranscriptionProviderChain({ providers: [
    { id: 'one', transcribe: async ({ language }) => { if (language) throw new Error(); return { text: 'uncertain', heardLanguage: null }; } },
    { id: 'two', transcribe: async () => ({ text: 'bonjour', heardLanguage: 'fr' }) }
  ], supportedLanguages: ['fr'] });
  expect((await chain.transcribe(Buffer.from([1]), { language: 'fr' })).provider).toBe('two');
});
test('provider receives audio and media type unchanged', async () => {
  const audio = Buffer.from([1, 2]); let received;
  const chain = createTranscriptionProviderChain({ providers: [{ id: 'one', transcribe: async (request) => { received = request; return { text: 'heard' }; } }] });
  await chain.transcribe(audio, { mediaType: 'audio/wav' });
  expect(received.audio).toBe(audio);
  expect(received.mediaType).toBe('audio/wav');
});
