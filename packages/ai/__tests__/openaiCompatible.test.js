const { askChatModel, createOpenAICompatibleProvider, createProviderRouter: createRouter, readToolArguments } = require('../src');

/* Every router is stopped even when an assertion fails first: its midnight
   timer would otherwise keep the test run alive. */
const openRouters = [];
const createProviderRouter = (config) => {
  const router = createRouter(config);
  openRouters.push(router);
  return router;
};
afterEach(() => { openRouters.splice(0).forEach((router) => router.stop()); });


const KEY = 'gsk_live_do_not_leak_1234';

function fakeFetch(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const next = typeof reply === 'function' ? reply(calls.length) : reply;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    }
  };
}

const text = (content, finish = 'stop') => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: finish }] } });

describe('askChatModel', () => {
  test('sends system, transcript, tools and the key in the header only', async () => {
    const { fetch, calls } = fakeFetch(text('Bonjour'));
    const answer = await askChatModel(
      { url: 'https://api.test/v1/chat/completions', key: KEY, model: 'm-1', extra: { reasoning_effort: 'low' } },
      {
        system: 'Tu es utile.',
        messages: [
          { role: 'user', text: 'Salut' },
          { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'lookup', args: { id: 3 } }] },
          { role: 'tool', toolCallId: 'c1', result: { ok: true } },
          { role: 'user', text: 'Et cette photo ?', images: [{ mimeType: 'image/png', data: 'AAAA' }] }
        ],
        tools: [{ name: 'lookup', parameters: {} }]
      },
      { fetch }
    );
    expect(answer).toEqual({ status: 200, text: 'Bonjour', cut: false });
    const { body, init } = calls[0];
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe('m-1');
    expect(body.reasoning_effort).toBe('low');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Tu es utile.' });
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: 'lookup', arguments: '{"id":3}' });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
    expect(body.messages[4].content[1].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'lookup', parameters: {} } });
  });

  test('think blocks never reach the reader, even unclosed', async () => {
    expect((await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text('<think>plan</think>Réponse')).fetch })).text).toBe('Réponse');
    expect((await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text('Début<think>jamais fermé')).fetch })).text).toBe('Début');
  });

  test('an answer cut at the length allowed says so', async () => {
    expect((await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text('...', 'length')).fetch })).cut).toBe(true);
  });

  test('malformed tool arguments are reported, not thrown: the turn survives', async () => {
    const reply = { status: 200, body: { choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'good', arguments: '{"q":"x"}' } },
      { id: 'b', function: { name: 'bad', arguments: '{"q":' } },
      { id: 'c', function: { name: 'none' } }
    ] } }] } };
    const answer = await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(reply).fetch });
    expect(answer.toolCalls).toEqual([
      { id: 'a', name: 'good', args: { q: 'x' } },
      { id: 'b', name: 'bad', args: null, invalid: true, invalidReason: 'not_json', invalidDetail: expect.any(String) },
      { id: 'c', name: 'none', args: {} }
    ]);
    expect(readToolArguments('[1,2]')).toEqual({ args: null, invalid: true, reason: 'not_object' });
  });

  test('why arguments cannot be read is said, so the model can be told what to fix', () => {
    expect(readToolArguments('{"q":')).toMatchObject({ args: null, invalid: true, reason: 'not_json', detail: expect.stringMatching(/JSON/) });
    expect(readToolArguments('"texte"')).toEqual({ args: null, invalid: true, reason: 'not_object' });
    expect(readToolArguments(['a'])).toEqual({ args: null, invalid: true, reason: 'not_object' });
    /* Aucun argument, ou des blancs : un appel sans paramètres, pas une faute. */
    expect(readToolArguments('  ')).toEqual({ args: {}, invalid: false });
    expect(readToolArguments({ q: 1 })).toEqual({ args: { q: 1 }, invalid: false });
  });

  test('unreadable arguments go back to the provider as an empty object, never "null"', async () => {
    const { fetch, calls } = fakeFetch(text('ok'));
    await askChatModel({ url: 'u', key: KEY, model: 'm' }, {
      messages: [{ role: 'assistant', text: null, toolCalls: [{ id: 'b', name: 'bad', args: null, invalid: true }] }]
    }, { fetch });
    expect(calls[0].body.messages[0].tool_calls[0].function.arguments).toBe('{}');
  });

  test('a closing think tag without its opening one takes everything before it', async () => {
    const ask = async (content) => (await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text(content)).fetch })).text;
    expect(await ask('le raisonnement sans balise ouvrante</think>\nPrie.')).toBe('Prie.');
    expect(await ask('<think>tout le raisonnement, coupé')).toBe('');
    expect(await ask('<THINK>a</THINK>Réponse')).toBe('Réponse');
  });

  test('a tool call written into the text becomes a real call when tools were offered, and is never an answer', async () => {
    const tools = [{ name: 'read_bible', parameters: { type: 'object' } }];
    const written = {
      xml: '<tool_call>\n<function=read_bible>\n<parameter=reference>\nPhilippiens 4:6\n</parameter>\n<parameter=verses>\n[6, 7]\n</parameter>\n</function>\n</tool_call>',
      json: '<tool_call>{"name": "read_bible", "arguments": "{\\"reference\\": \\"Philippiens 4:6\\", \\"verses\\": [6, 7]}"}</tool_call>'
    };
    for (const [kind, content] of Object.entries(written)) {
      const answer = await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [], tools }, { fetch: fakeFetch(text(content)).fetch });
      expect({ kind, ...answer }).toEqual({ kind, status: 200, text: null, toolCalls: [{ id: 'written-1', name: 'read_bible', args: { reference: 'Philippiens 4:6', verses: [6, 7] } }] });
    }
    /* Sans outils proposés, ou illisible : il ne reste rien à montrer. */
    const noTools = await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text(written.json)).fetch });
    expect(noTools).toEqual({ status: 200, text: null, toolCalls: [] });
    const garbled = await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [], tools }, { fetch: fakeFetch(text('<tool_call>{"name": oops}</tool_call>')).fetch });
    expect(garbled).toEqual({ status: 200, text: null, toolCalls: [] });
    /* Le protocole écrit de runAgentLoop (<tool_call name="…">) n'est pas concerné. */
    const loopProtocol = '<tool_call name="lookup">{"id": 1}</tool_call>';
    expect((await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch(text(loopProtocol)).fetch })).text).toBe(loopProtocol);
  });

  test('a refusal resolves its status; nothing is thrown for it', async () => {
    expect(await askChatModel({ url: 'u', key: KEY, model: 'm' }, { messages: [] }, { fetch: fakeFetch({ status: 429, body: {} }).fetch })).toEqual({ status: 429 });
  });
});

describe('createOpenAICompatibleProvider', () => {
  const models = [{ id: 'fast', complexity: ['simple'] }];

  test('plugs into the router; the key is read at every call', async () => {
    let key = 'first-key';
    const { fetch, calls } = fakeFetch(text('ok'));
    const provider = createOpenAICompatibleProvider({ id: 'groq', url: 'https://api.test', getKey: () => key, models, fetch });
    const router = createProviderRouter({ providers: [provider] });
    await expect(router.ask('hello', { complexity: 'simple' })).resolves.toBe('ok');
    key = 'second-key';
    await router.ask('again', { complexity: 'simple' });
    expect(calls.map((c) => c.init.headers.authorization)).toEqual(['Bearer first-key', 'Bearer second-key']);
    expect(calls[0].body.model).toBe('fast');
    router.stop();
  });

  test('a 429 reaches the router as a status (cooldown), and the key is in no error', async () => {
    const provider = createOpenAICompatibleProvider({ id: 'groq', url: 'u', getKey: () => KEY, models, fetch: fakeFetch({ status: 429, body: {} }).fetch });
    const error = await provider.call('x', {}, models[0]).catch((e) => e);
    expect(error.statusCode).toBe(429);
    expect(`${error.message}${error.stack}`).not.toContain(KEY);
  });

  test('no key is a 401 before any request; an empty answer is a 502', async () => {
    const { fetch, calls } = fakeFetch(text(''));
    const keyless = createOpenAICompatibleProvider({ id: 'p', url: 'u', getKey: () => null, models, fetch });
    await expect(keyless.call('x', {}, models[0])).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(0);
    const empty = createOpenAICompatibleProvider({ id: 'p', url: 'u', getKey: () => KEY, models, fetch });
    await expect(empty.call('x', {}, models[0])).rejects.toMatchObject({ statusCode: 502 });
  });

  test('url and key are read per call from the context; a model has its own switches; ctx.fetch and ctx.timeoutMs win for one call', async () => {
    const own = fakeFetch(text('ok'));
    const perCall = fakeFetch(text('per call'));
    const provider = createOpenAICompatibleProvider({
      id: 'cloudflare',
      url: (ctx) => (ctx.env.ACCOUNT ? `https://api.test/${ctx.env.ACCOUNT}/chat` : null),
      getKey: (ctx) => ctx.env.TOKEN,
      extra: { temperature_hint: 1 },
      models,
      fetch: own.fetch
    });
    expect(await provider.available({ env: { TOKEN: 't' } })).toBe(false);
    expect(await provider.available({ env: { TOKEN: 't', ACCOUNT: 'a1' } })).toBe(true);
    expect(await provider.call('x', { env: { TOKEN: 't', ACCOUNT: 'a1' } }, { id: 'm', extra: { include_reasoning: false } })).toBe('ok');
    expect(own.calls[0].url).toBe('https://api.test/a1/chat');
    expect(own.calls[0].body).toMatchObject({ temperature_hint: 1, include_reasoning: false });
    expect(await provider.call('x', { env: { TOKEN: 't', ACCOUNT: 'a1' }, fetch: perCall.fetch }, { id: 'm' })).toBe('per call');
    expect(own.calls).toHaveLength(1);
    await expect(provider.call('x', { env: { TOKEN: 't' } }, { id: 'm' })).rejects.toMatchObject({ statusCode: 401 });
  });

  test('detailed: the call gives the whole answer — an empty text or a cut one too — for the router to judge', async () => {
    const provider = (reply) => createOpenAICompatibleProvider({ id: 'p', url: 'u', getKey: () => KEY, models, detailed: true, toRequest: (request) => request, fetch: fakeFetch(reply).fetch });
    expect(await provider(text('')).call({ messages: [] }, {}, models[0])).toEqual({ text: '', toolCalls: [], cut: false });
    expect(await provider(text('Une phrase. Une autre', 'length')).call({ messages: [] }, {}, models[0])).toEqual({ text: 'Une phrase. Une autre', toolCalls: [], cut: true });
    await expect(provider({ status: 503, body: {} }).call({ messages: [] }, {}, models[0])).rejects.toMatchObject({ statusCode: 503 });
  });

  test('a lane is handed to the router', () => {
    const provider = createOpenAICompatibleProvider({ id: 'p', url: 'u', getKey: () => KEY, models, fetch: () => {}, lane: (ctx) => ctx.purpose });
    expect(provider.lane({ purpose: 'news' })).toBe('news');
  });

  test('a local endpoint can say it is on this machine: the router will not mask for it', () => {
    const provider = createOpenAICompatibleProvider({ id: 'ollama', url: 'http://127.0.0.1:11434', getKey: () => 'x', models, fetch: fakeFetch(text('ok')).fetch, external: false });
    expect(provider.external).toBe(false);
  });

  test('wiring mistakes are refused up front', () => {
    expect(() => createOpenAICompatibleProvider({ url: 'u', getKey: () => 'k', fetch: () => {} })).toThrow(/id/);
    expect(() => createOpenAICompatibleProvider({ id: 'p', url: 'u', fetch: () => {} })).toThrow(/getKey/);
    expect(() => createOpenAICompatibleProvider({ id: 'p', url: 'u', getKey: () => 'k' })).toThrow(/fetch/);
  });
});
