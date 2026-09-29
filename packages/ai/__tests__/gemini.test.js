const { askGeminiModel, createGeminiProvider, createProviderRouter } = require('../src');

const KEY = 'AIza_do_not_leak_1234';

function fakeFetch(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const next = typeof reply === 'function' ? reply(calls.length, url) : reply;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    }
  };
}

const parts = (list, finishReason = 'STOP') => ({ status: 200, body: { candidates: [{ content: { parts: list }, finishReason }] } });

const tools = [{ name: 'read_bible', description: 'Lit un passage.', parameters: { type: 'object', properties: { reference: { type: 'string' } } } }];
const transcript = {
  system: 'Utilise les outils.',
  tools,
  messages: [
    { role: 'user', text: 'Lis Philippiens 4:6.' },
    { role: 'assistant', text: null, toolCalls: [{ id: 'call_1', name: 'read_bible', args: { reference: 'Philippiens 4:6' } }] },
    { role: 'tool', toolCallId: 'call_1', name: 'read_bible', result: { text: 'Ne vous inquiétez de rien.' } }
  ]
};

describe('askGeminiModel', () => {
  test('translates the consigne, the transcript and the tools, the key in the header only, then reads a function call', async () => {
    const { fetch, calls } = fakeFetch(parts([{ functionCall: { name: 'read_bible', args: { reference: 'Philippiens 4:6' } } }]));
    const answer = await askGeminiModel('gemini-3.6-flash', transcript, { key: KEY, fetch });
    const { url, init, body } = calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(url).not.toContain(KEY);
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Utilise les outils.' }] });
    expect(body.tools).toEqual([{ functionDeclarations: tools }]);
    expect(body.generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 1200 });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Lis Philippiens 4:6.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_bible', args: { reference: 'Philippiens 4:6' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_bible', response: { result: { text: 'Ne vous inquiétez de rien.' } } } }] }
    ]);
    expect(answer).toEqual({ status: 200, text: null, toolCalls: [{ id: 'call_0', name: 'read_bible', args: { reference: 'Philippiens 4:6' } }] });
  });

  test('Gemma gets the consigne at the head of the first message, a photo still after the words', async () => {
    const photo = { mimeType: 'image/jpeg', data: 'AAAA' };
    const { fetch, calls } = fakeFetch(parts([{ text: 'Une page.' }]));
    await askGeminiModel('gemma-4-26b-a4b-it', { system: 'Lis la photo.', messages: [{ role: 'user', text: 'Que dit-elle ?', images: [photo] }] }, { key: KEY, fetch });
    expect(calls[0].body.systemInstruction).toBeUndefined();
    expect(calls[0].body.contents[0].parts).toEqual([{ text: 'Lis la photo.\n\nQue dit-elle ?' }, { inlineData: photo }]);
    await askGeminiModel('gemini-x', { system: 's', messages: [{ role: 'user', text: 'q', images: [photo] }] }, { key: KEY, fetch });
    expect(calls[1].body.contents[0].parts).toEqual([{ text: 'q' }, { inlineData: photo }]);
  });

  test('the thinking parts and think tags are never shown; an answer at its length says it is cut', async () => {
    const thought = fakeFetch(parts([{ text: 'je réfléchis', thought: true }, { text: '<think>encore</think>Réponse' }], 'MAX_TOKENS'));
    expect(await askGeminiModel('gemini-x', { messages: [] }, { key: KEY, fetch: thought.fetch })).toEqual({ status: 200, text: 'Réponse', cut: true });
  });

  test('a call written into the text is read back; a refusal resolves its status', async () => {
    const written = fakeFetch(parts([{ text: '<tool_call>{"name": "read_bible", "arguments": {"reference": "Jean 3:16"}}</tool_call>' }]));
    expect(await askGeminiModel('gemini-x', transcript, { key: KEY, fetch: written.fetch })).toEqual({
      status: 200, text: null, toolCalls: [{ id: 'written-1', name: 'read_bible', args: { reference: 'Jean 3:16' } }]
    });
    expect(await askGeminiModel('gemini-x', transcript, { key: KEY, fetch: fakeFetch({ status: 429, body: {} }).fetch })).toEqual({ status: 429 });
  });

  test('unreadable arguments of an earlier call go back as an empty object', async () => {
    const { fetch, calls } = fakeFetch(parts([{ text: 'ok' }]));
    await askGeminiModel('gemini-x', { messages: [{ role: 'assistant', text: null, toolCalls: [{ id: 'a', name: 'read_bible', args: null, invalid: true }] }] }, { key: KEY, fetch });
    expect(calls[0].body.contents[0].parts[0].functionCall.args).toEqual({});
  });
});

describe('createGeminiProvider', () => {
  test('plugs into the router: key per call, a lane for a use with its own key, skipped without any key', async () => {
    const { fetch, calls } = fakeFetch(parts([{ text: 'Oui.' }]));
    const keys = { general: 'general', news: 'news-key' };
    const provider = createGeminiProvider({
      getKey: (ctx) => (ctx.purpose === 'news' ? keys.news : keys.general),
      lane: (ctx) => (ctx.purpose === 'news' ? 'news' : null),
      models: [{ id: 'gemini-x' }],
      fetch
    });
    const router = createProviderRouter({ providers: [provider] });
    try {
      expect(await router.route('Bonjour', {}, { purpose: 'news' })).toMatchObject({ value: 'Oui.', provider: 'gemini', model: 'gemini-x', key: 'gemini:gemini-x@news' });
      expect(await router.route('Bonjour', {}, {})).toMatchObject({ key: 'gemini:gemini-x' });
      expect(calls.map((call) => call.init.headers['x-goog-api-key'])).toEqual(['news-key', 'general']);
      keys.general = null;
      await expect(router.ask('Bonjour', {}, {})).rejects.toMatchObject({ statusCode: 503, code: 'AI_NO_PROVIDER' });
      expect(calls).toHaveLength(2);
    } finally {
      router.stop();
    }
  });

  test('a refusal reaches the router with its status, and the key is in no error', async () => {
    const provider = createGeminiProvider({ getKey: () => KEY, models: [{ id: 'g' }], fetch: fakeFetch({ status: 503, body: {} }).fetch });
    const error = await provider.call('x', {}, { id: 'g' }).catch((e) => e);
    expect(error.statusCode).toBe(503);
    expect(`${error.message}${error.stack}`).not.toContain(KEY);
  });

  test('wiring mistakes are refused up front', () => {
    expect(() => createGeminiProvider({ fetch: () => {} })).toThrow(/getKey/);
    expect(() => createGeminiProvider({ getKey: () => 'k' })).toThrow(/fetch/);
  });
});
