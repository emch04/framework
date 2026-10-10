const { askChatModel, askGeminiModel, createOpenAICompatibleProvider, createProviderRouter: createRouter, visibleSoFar } = require('../src');

const openRouters = [];
afterEach(() => { openRouters.splice(0).forEach((router) => router.stop()); });

/* Un corps `text/event-stream` découpé n'importe où, comme sur le réseau. */
function streamed(events, cut = 7) {
  const raw = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = new globalThis.TextEncoder().encode(raw);
  let at = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: { getReader: () => ({ read: async () => (at >= bytes.length ? { done: true } : { done: false, value: bytes.slice(at, (at += cut)) }) }) },
    json: async () => { throw new Error('pas de JSON pour un flux'); }
  };
}

describe('réponse en flux', () => {
  test('OpenAI : le texte montré grandit à chaque morceau, la valeur rendue est la même que sans flux', async () => {
    const seen = [];
    let body;
    const answer = await askChatModel({ url: 'https://api.test/v1/chat/completions', key: 'k', model: 'm' }, { messages: [{ role: 'user', text: 'Salut' }] }, {
      fetch: async (_url, init) => { body = JSON.parse(init.body); return streamed([
        { choices: [{ delta: { content: '<think>je réfléchis' } }] },
        { choices: [{ delta: { content: '</think>Bon' } }] },
        { choices: [{ delta: { content: 'jour, Emch.' }, finish_reason: 'stop' }] },
        '[DONE]'
      ]); },
      onText: (t) => seen.push(t)
    });
    expect(body.stream).toBe(true);
    expect(seen).toEqual(['Bon', 'Bonjour, Emch.']);
    expect(answer).toEqual({ status: 200, text: 'Bonjour, Emch.', cut: false });
  });

  test('OpenAI : les appels d’outils arrivent en morceaux et sont recollés ; rien n’est montré', async () => {
    const seen = [];
    const answer = await askChatModel({ url: 'https://api.test/x', key: 'k', model: 'm' }, { messages: [{ role: 'user', text: 'Q' }], tools: [{ name: 'chercher', parameters: {} }] }, {
      fetch: async () => streamed([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'chercher', arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: 'tool_calls' }] }
      ]),
      onText: (t) => seen.push(t)
    });
    expect(seen).toEqual([]);
    expect(answer.toolCalls).toEqual([expect.objectContaining({ id: 'c1', name: 'chercher', args: { q: 'ok' } })]);
  });

  test('Gemini : streamGenerateContent, sans la réflexion ; sources et fin gardées', async () => {
    const seen = [];
    let url;
    const answer = await askGeminiModel('gemini-x', { messages: [{ role: 'user', text: 'Q' }], googleSearch: true }, {
      key: 'k',
      fetch: async (u) => { url = u; return streamed([
        { candidates: [{ content: { parts: [{ text: 'je pense', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Le serveur ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'répond.' }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [{ web: { uri: 'https://a.test/p', title: 'A' } }] } }] }
      ], 11); },
      onText: (t) => seen.push(t)
    });
    expect(url).toMatch(/gemini-x:streamGenerateContent\?alt=sse$/);
    expect(seen).toEqual(['Le serveur', 'Le serveur répond.']);
    expect(answer.text).toBe('Le serveur répond.');
    expect(answer.grounding.sources).toEqual([{ title: 'A', url: 'https://a.test/p' }]);
  });

  test('sans onText, rien ne change (pas de flux demandé)', async () => {
    let body;
    await askChatModel({ url: 'https://api.test/x', key: 'k', model: 'm' }, { messages: [{ role: 'user', text: 'Q' }] }, {
      fetch: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; }
    });
    expect(body.stream).toBeUndefined();
  });

  test('ce qui se montre : ni appel écrit, ni JSON, ni balise coupée', () => {
    expect(visibleSoFar('Voici <tool_call>{"name":"x"}')).toBe('');
    expect(visibleSoFar('{"reponse":')).toBe('');
    expect(visibleSoFar('Bonjour <thi')).toBe('Bonjour');
    expect(visibleSoFar('<think>long')).toBe('');
  });

  test('le routeur passe onText au fournisseur, et le texte repart de zéro au modèle suivant', async () => {
    const seen = [];
    let calls = 0;
    const provider = createOpenAICompatibleProvider({
      id: 'p', url: 'https://api.test/x', getKey: () => 'k', models: [{ id: 'a' }, { id: 'b' }], detailed: true,
      toRequest: (r) => r,
      fetch: async () => (++calls === 1
        ? streamed([{ choices: [{ delta: { content: 'Premier essai' }, finish_reason: 'length' } ] }])
        : streamed([{ choices: [{ delta: { content: 'Réponse' }, finish_reason: 'stop' }] }]))
    });
    const router = createRouter({ providers: [provider] });
    openRouters.push(router);
    const r = await router.route({ messages: [{ role: 'user', text: 'Q' }] }, { accepts: (v) => !v.cut }, { onText: (t) => seen.push(t) });
    expect(r.value.text).toBe('Réponse');
    expect(seen).toEqual(['Premier essai', 'Réponse']);
  });
});
