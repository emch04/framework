const {
  createProviderRouter: createRouter,
  createReversibleMasker,
  createToolRegistry,
  headWithoutCuttingWords,
  runAgentLoop,
  withOutboundMasking
} = require('../src');

/* Every router is stopped even when an assertion fails first: its midnight
   timer would otherwise keep the test run alive. */
const openRouters = [];
const createProviderRouter = (config) => {
  const router = createRouter(config);
  openRouters.push(router);
  return router;
};
afterEach(() => { openRouters.splice(0).forEach((router) => router.stop()); });


const EMAIL = { type: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g };

describe('createReversibleMasker', () => {
  test('masks register names, and unmasks the answer back', () => {
    const masker = createReversibleMasker({ names: ['Josué Mbala', 'Kevin'] });
    const masked = masker.mask('Josué Mbala et Kevin sont absents');
    expect(masked).not.toMatch(/Josué|Kevin/);
    expect(masker.unmask(`Réponse : ${masked}`)).toBe('Réponse : Josué Mbala et Kevin sont absents');
  });

  test('the register is case-sensitive: "Grace" is masked, "grâce à" and "la chance" survive', () => {
    const masker = createReversibleMasker({ names: ['Grace', 'Chance'] });
    const masked = masker.mask('Grace a réussi grâce à son travail, la chance n\'y est pour rien');
    expect(masked).not.toContain('Grace ');
    expect(masked).toContain('grâce à');
    expect(masked).toContain('la chance');
  });

  test('whole words only: "Ali" inside "Alice" is left alone', () => {
    const masker = createReversibleMasker({ names: ['Ali'] });
    expect(masker.mask('Alice et Ali')).toMatch(/^Alice et #PERSON_\d{4}$/);
  });

  test('longest first: "Marie Kabongo" is one token, not "Marie" plus a surname in clear', () => {
    const masker = createReversibleMasker({ names: ['Marie', 'Marie Kabongo'] });
    const masked = masker.mask('Marie Kabongo est venue');
    expect(masked).not.toContain('Kabongo');
    expect(masked.match(/#PERSON_\d{4}/g)).toHaveLength(1);
  });

  test('a name shorter than three letters is never masked, and absent names create no token', () => {
    const masker = createReversibleMasker({ names: ['Jo', 'Absent Person', 'Kevin'] });
    expect(masker.mask('Jo et Kevin')).toMatch(/^Jo et #PERSON_\d{4}$/);
    expect(masker.size()).toBe(1);
  });

  test('the same person always gets the same token, so two people stay distinct', () => {
    const masker = createReversibleMasker({ names: ['Kevin', 'Grace'] });
    const first = masker.mask('Kevin');
    expect(masker.mask('Kevin encore')).toBe(`${first} encore`);
    expect(masker.mask('Grace')).not.toBe(first);
  });

  test('patterns mask structured data in any case, and it comes back as written first', () => {
    const masker = createReversibleMasker({ patterns: [EMAIL] });
    const masked = masker.mask('Écris à parent.mbala@ecole.cd');
    expect(masked).toMatch(/^Écris à #EMAIL_\d{4}$/);
    expect(masker.unmask(masked)).toBe('Écris à parent.mbala@ecole.cd');
  });

  test('a model that drops the "#" of a token still gets the name back', () => {
    const masker = createReversibleMasker({ names: ['Kevin'] });
    const token = masker.mask('Kevin');
    expect(masker.unmask(`Bravo ${token.slice(1)} !`)).toBe('Bravo Kevin !');
  });

  test('a token never eats the start of a longer one', () => {
    let n = 0;
    const masker = createReversibleMasker({ names: ['Alpha', 'Bravo'], token: () => (n += 1) === 1 ? '#P_1' : '#P_12' });
    masker.mask('Alpha Bravo');
    expect(masker.unmask('#P_12 et #P_1')).toBe('Bravo et Alpha');
  });

  test('maskDeep and unmaskDeep walk structures and leave keys alone', () => {
    const masker = createReversibleMasker({ names: ['Kevin'] });
    const masked = masker.maskDeep({ Kevin: 'Kevin', list: ['Kevin', 3], at: new Date(0) });
    expect(Object.keys(masked)).toContain('Kevin');
    expect(masked.list[0]).toMatch(/^#PERSON_/);
    expect(masked.list[1]).toBe(3);
    expect(masker.unmaskDeep(masked).list[0]).toBe('Kevin');
  });

  test('the detector finds the first name no register knows; weak, short and already-masked hits are ignored', async () => {
    const detect = jest.fn(async () => [
      { text: 'Kevin', type: 'person', score: 0.93 },
      { text: 'Grace', type: 'person', score: 0.59 },
      { text: 'Jo', type: 'person', score: 0.95 },
      { text: '#PERSON_0003', type: 'person', score: 0.9 },
      { text: 'Kinshasa', type: 'place', score: 0.9 },
      { text: 'Kevin', type: 'person', score: 0.8 }
    ]);
    const masker = createReversibleMasker({ detect });
    expect(await masker.detectNames('Kevin a encore frappé sa sœur')).toEqual(['Kevin']);
    const masked = await masker.maskAsync('Kevin a encore frappé sa sœur');
    expect(masked).not.toContain('Kevin');
    /* Learnt: the next synchronous mask knows him. */
    expect(masker.mask('Kevin revient')).not.toContain('Kevin');
  });

  test('the detector sees at most detectMaxChars, cut on a blank; its failure leaves the register alone', async () => {
    const seen = [];
    const masker = createReversibleMasker({ names: ['Kevin'], detectMaxChars: 12, detect: async (text) => { seen.push(text); throw new Error('down'); } });
    const masked = await masker.maskAsync('Kevin Mbala est arrivé');
    expect(seen).toEqual(['Kevin Mbala']);
    expect(masked).not.toContain('Kevin');
    expect(headWithoutCuttingWords('abcdef', 3)).toBe('abc');
  });

  test('unmaskStream puts names back even when a token straddles two chunks', async () => {
    const masker = createReversibleMasker({ names: ['Kevin'] });
    const token = masker.mask('Kevin');
    async function* chunks() { yield `Bonjour ${token.slice(0, 5)}`; yield `${token.slice(5)}, comment vas-tu ?`; }
    let out = '';
    for await (const chunk of masker.unmaskStream(chunks())) out += chunk;
    expect(out).toBe('Bonjour Kevin, comment vas-tu ?');
  });

  test('keep() protects words that must stay (a product name)', () => {
    const masker = createReversibleMasker({ names: ['Oracle', 'Kevin'], keep: (value) => value === 'Oracle' });
    expect(masker.mask('Oracle aide Kevin')).toMatch(/^Oracle aide #PERSON_/);
  });

  test('a non-global pattern is refused: it would mask the first hit and leak the rest', () => {
    expect(() => createReversibleMasker({ patterns: [{ type: 'EMAIL', pattern: /@/ }] })).toThrow(/global/);
  });

  test('withOutboundMasking masks what leaves and unmasks what comes back', async () => {
    const masker = createReversibleMasker({ names: ['Kevin'] });
    const sent = [];
    const search = withOutboundMasking(masker, async (query) => { sent.push(query); return { answer: `Résultats pour ${query}` }; });
    const result = await search('notes de Kevin');
    expect(sent[0]).not.toContain('Kevin');
    expect(result.answer).toBe('Résultats pour notes de Kevin');
    expect(() => withOutboundMasking({}, () => {})).toThrow(/masker/);
  });
});

describe('outbound masking in the provider router', () => {
  const model = { id: 'm', complexity: ['simple'] };

  test('an external provider receives masked text; the caller reads the names back', async () => {
    const received = [];
    const router = createProviderRouter({ providers: [{ id: 'cloud', models: [model], call: async (prompt, ctx) => { received.push({ prompt, ctx }); return `Voici pour ${prompt.split(' ').pop()}`; } }] });
    const masker = createReversibleMasker({ names: ['Kevin'] });
    await expect(router.ask('résume Kevin', { complexity: 'simple' }, { masker, tenant: 't1' })).resolves.toBe('Voici pour Kevin');
    expect(received[0].prompt).not.toContain('Kevin');
    expect(received[0].ctx).toEqual({ tenant: 't1' });
    router.stop();
  });

  test('a provider on this machine (external: false) gets the text as it is', async () => {
    const received = [];
    const router = createProviderRouter({ providers: [{ id: 'local', external: false, models: [model], call: async (prompt) => { received.push(prompt); return 'ok'; } }] });
    await router.ask('résume Kevin', { complexity: 'simple' }, { masker: createReversibleMasker({ names: ['Kevin'] }) });
    expect(received).toEqual(['résume Kevin']);
    router.stop();
  });

  test('a streamed answer is unmasked chunk by chunk', async () => {
    const masker = createReversibleMasker({ names: ['Kevin'] });
    const router = createProviderRouter({
      providers: [{ id: 'cloud', models: [model], call: async (prompt) => (async function* () { const token = prompt.split(' ').pop(); yield `Salut ${token.slice(0, 3)}`; yield token.slice(3); })() }]
    });
    let out = '';
    for await (const chunk of await router.ask('dis bonjour à Kevin', { complexity: 'simple' }, { masker })) out += chunk;
    expect(out).toBe('Salut Kevin');
    router.stop();
  });
});

describe('outbound masking in the agent loop', () => {
  function setup(answers) {
    const prompts = [];
    const router = { ask: async (prompt) => { prompts.push(prompt); return answers.shift(); } };
    const registry = createToolRegistry();
    const searched = [];
    const lookedUp = [];
    registry.register({ name: 'web_search', description: 'Search the web', type: 'read', roles: ['parent'], external: true, handler: async (params) => { searched.push(params); return { results: [`news about ${params.query}`] }; } });
    registry.register({ name: 'get_grades', description: 'Grades', type: 'read', roles: ['parent'], handler: async (params) => { lookedUp.push(params); return { student: params.student, average: 14 }; } });
    return { router, registry, prompts, searched, lookedUp };
  }

  test('an EXTERNAL tool receives masked parameters — the name never reaches the search engine', async () => {
    const masker = createReversibleMasker({ names: ['Kevin Mbala'] });
    const token = () => masker.mask('Kevin Mbala');
    const answers = [];
    const { router, registry, prompts, searched } = setup(answers);
    answers.push(null, null);
    router.ask = async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? `<tool_call name="web_search">{"query":"${token()} concours"}</tool_call>` : `Rien de neuf pour ${token()}.`;
    };
    const answer = await runAgentLoop({ prompt: 'Actualités sur Kevin Mbala ?', registry, router, userRole: 'parent', masker });
    expect(searched[0].query).not.toContain('Kevin');
    expect(searched[0].query).toMatch(/#PERSON_\d{4} concours/);
    expect(prompts.every((prompt) => !prompt.includes('Kevin'))).toBe(true);
    expect(answer).toBe('Rien de neuf pour Kevin Mbala.');
  });

  test('an INTERNAL tool gets real names — it has to find the record', async () => {
    const masker = createReversibleMasker({ names: ['Kevin Mbala'] });
    const { router, registry, lookedUp, prompts } = setup([]);
    router.ask = async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? `<tool_call name="get_grades">{"student":"${masker.mask('Kevin Mbala')}"}</tool_call>` : 'Moyenne 14.';
    };
    await runAgentLoop({ prompt: 'Moyenne de Kevin Mbala ?', registry, router, userRole: 'parent', masker });
    expect(lookedUp[0].student).toBe('Kevin Mbala');
    expect(prompts[1]).not.toContain('Kevin');
  });

  test('names found by the detector in a tool result are masked before the next prompt', async () => {
    const masker = createReversibleMasker({ detect: async (text) => (text.includes('Grace Ilunga') ? [{ text: 'Grace Ilunga', type: 'person', score: 0.9 }] : []) });
    const registry = createToolRegistry();
    registry.register({ name: 'list_class', description: 'Class', type: 'read', roles: ['teacher'], handler: async () => ({ pupils: ['Grace Ilunga'] }) });
    const prompts = [];
    const router = { ask: async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? '<tool_call name="list_class">{}</tool_call>' : 'Une élève.'; } };
    await runAgentLoop({ prompt: 'Qui est dans ma classe ?', registry, router, userRole: 'teacher', masker });
    expect(prompts[1]).not.toContain('Grace Ilunga');
  });
});
