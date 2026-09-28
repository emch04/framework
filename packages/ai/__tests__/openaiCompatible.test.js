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
      { id: 'b', name: 'bad', args: null, invalid: true },
      { id: 'c', name: 'none', args: {} }
    ]);
    expect(readToolArguments('[1,2]')).toEqual({ args: null, invalid: true });
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
