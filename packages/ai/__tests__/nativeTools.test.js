const { createToolCaller, runToolLoop, stepParams, toolSpecs, validateNativeTools } = require('../src');

const tool = (overrides = {}) => ({
  name: 'read_bible',
  description: 'Lit un passage de la Bible.',
  parameters: { type: 'object', properties: { reference: { type: 'string' } } },
  kind: 'read',
  summary: (args) => ({ reference: String(args.reference ?? '') }),
  run: async ({ reference }) => ({ data: `${reference} : lu.`, sources: [{ kind: 'bible', title: reference, ref: { reference } }] }),
  ...overrides
});

function recorder() {
  const events = [];
  return { events, emit: (type, data) => events.push({ type, data }) };
}

describe('validateNativeTools', () => {
  test('an invalid tool is refused, named, with the reason', () => {
    const cases = [
      [tool({ name: 'Read Bible' }), /name/],
      [tool({ description: ' ' }), /description/],
      [tool({ parameters: { type: 'string' } }), /parameters/],
      [tool({ kind: 'delete' }), /kind/],
      [tool({ summary: 'Je lis' }), /summary is not a function/],
      [tool({ summary: () => ({ page: { book: 1 } }) }), /summary does not give an object/],
      [tool({ summary: (args) => ({ reference: args.reference.trim() }) }), /summary fails without arguments/],
      [tool({ run: null }), /run/],
      [tool({ kind: 'confirm' }), /perform/],
      [tool({ kind: 'write' }), /undo/]
    ];
    for (const [bad, reason] of cases) expect(() => validateNativeTools([bad])).toThrow(reason);
    expect(() => validateNativeTools([tool(), tool()])).toThrow(/read_bible.*twice/);
    expect(() => validateNativeTools([tool({ name: 'Bad' })])).toThrow(/The agent tool Bad is not valid/);
  });

  test('a summary is optional unless asked for; kinds can be the caller\'s', () => {
    expect(() => validateNativeTools([tool({ summary: undefined })])).not.toThrow();
    expect(() => validateNativeTools([tool({ summary: undefined })], { requireSummary: true })).toThrow(/summary/);
    expect(() => validateNativeTools([tool({ kind: 'lookup' })], { kinds: ['lookup'] })).not.toThrow();
  });

  test('the model sees a tool by its name, description and parameters only', () => {
    expect(toolSpecs([tool()])).toEqual([{ name: 'read_bible', description: 'Lit un passage de la Bible.', parameters: tool().parameters }]);
  });
});

describe('stepParams', () => {
  test('strings and numbers, cut at 120 characters; nothing when the summary fails or is missing', () => {
    const summary = (args) => ({ reference: args.reference, paragraph: args.paragraph, page: { book: 50 }, gone: undefined });
    expect(stepParams(tool({ summary }), { reference: 'Jean 3:16', paragraph: 12 })).toEqual({ reference: 'Jean 3:16', paragraph: 12 });
    const long = stepParams(tool(), { reference: 'a'.repeat(300) }).reference;
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
    expect(stepParams(tool(), null)).toEqual({ reference: '' });
    expect(stepParams(tool({ summary: () => { throw new Error('non'); } }), {})).toEqual({});
    expect(stepParams(tool({ summary: undefined }), {})).toEqual({});
    expect(stepParams(undefined, {})).toEqual({});
  });
});

describe('createToolCaller', () => {
  test('runs the tool with the context and a signal, shows its step, keeps its sources, measures it', async () => {
    let seen;
    const kept = [];
    const measured = [];
    const { emit, events } = recorder();
    const call = createToolCaller({
      tools: [tool({ run: async (args, ctx) => { seen = ctx; return { data: 'lu', sources: [{ kind: 'bible' }] }; } })],
      context: { userId: 'u1' },
      emit,
      keep: (sources, data) => kept.push({ sources, data }),
      onCall: (stats) => measured.push(stats)
    });
    const message = await call({ id: 'c1', name: 'read_bible', args: { reference: 'Jean 3:16' } });
    expect(message).toEqual({ role: 'tool', toolCallId: 'c1', name: 'read_bible', result: 'lu' });
    expect(seen.userId).toBe('u1');
    expect(seen.signal).toBeInstanceOf(globalThis.AbortSignal);
    expect(events).toEqual([
      { type: 'step', data: { id: 's1', tool: 'read_bible', params: { reference: 'Jean 3:16' } } },
      { type: 'step_done', data: { id: 's1', ok: true } }
    ]);
    expect(kept).toEqual([{ sources: [{ kind: 'bible' }], data: 'lu' }]);
    expect(measured).toEqual([{ name: 'read_bible', ms: expect.any(Number), ok: true }]);
  });

  test('a tool that fails, an invented tool and unreadable arguments are errors the model reads', async () => {
    let ran = 0;
    const { emit, events } = recorder();
    const call = createToolCaller({
      tools: [tool({ name: 'broken', run: async () => { throw new Error('la bibliothèque est fermée'); } }), tool({ run: async () => { ran += 1; return { data: 'lu' }; } })],
      emit
    });
    expect((await call({ id: 'a', name: 'broken', args: {} })).result).toEqual({ error: 'la bibliothèque est fermée' });
    expect((await call({ id: 'b', name: 'nowhere', args: {} })).result).toEqual({ error: 'There is no tool called nowhere.' });
    const notJson = await call({ id: 'c', name: 'read_bible', args: null, invalid: true, invalidReason: 'not_json', invalidDetail: 'Unexpected end of JSON input' });
    expect(notJson.result.error).toBe('The arguments of this call were not valid JSON (Unexpected end of JSON input): call the tool again with a JSON object.');
    const notObject = await call({ id: 'd', name: 'read_bible', args: null, invalid: true, invalidReason: 'not_object' });
    expect(notObject.result.error).toMatch(/must be a JSON object/);
    expect(ran).toBe(0);
    expect(events.filter((event) => event.type === 'step_done').map((event) => event.data.ok)).toEqual([false, false, false, false]);
    expect(events.filter((event) => event.type === 'step').map((event) => event.data.params)).toEqual([{ reference: '' }, {}, { reference: '' }, { reference: '' }]);
  });

  test('a tool that takes too long is stopped, told to stop, and the model told', async () => {
    let aborted = false;
    const call = createToolCaller({
      tools: [tool({ name: 'stuck', run: (_args, ctx) => new Promise(() => ctx.signal.addEventListener('abort', () => { aborted = true; })) })],
      timeoutMs: 20
    });
    expect((await call({ id: 'a', name: 'stuck', args: {} })).result).toEqual({ error: 'This tool took too long to answer.' });
    expect(aborted).toBe(true);
  });

  test('what a tool gives the model is bounded', async () => {
    const call = createToolCaller({ tools: [tool({ run: async () => ({ data: 'x'.repeat(50_000) }) })], resultMax: 100 });
    const { result } = await call({ id: 'a', name: 'read_bible', args: {} });
    expect(result).toHaveLength(101);
    expect(result.endsWith('…')).toBe(true);
  });

  test('a tool to confirm writes nothing: the model reads that it waits; the record hook keeps it', async () => {
    const recorded = [];
    const call = createToolCaller({
      tools: [tool({ name: 'save_note', kind: 'confirm', run: async ({ text }) => ({ data: { preview: text }, card: { kind: 'confirm' } }), perform: async () => {} })],
      record: async (entry) => { recorded.push(entry); },
      messages: { waiting: 'Rien n’est écrit : la personne doit confirmer.' }
    });
    const { result } = await call({ id: 'a', name: 'save_note', args: { text: 'Prier.' } });
    expect(result).toEqual({ data: { preview: 'Prier.' }, status: 'Rien n’est écrit : la personne doit confirmer.' });
    expect(recorded).toEqual([{ tool: expect.objectContaining({ name: 'save_note' }), args: { text: 'Prier.' }, found: { data: { preview: 'Prier.' }, card: { kind: 'confirm' } } }]);
  });

  test('when the person leaves, the call raises the reason instead of an error for the model', async () => {
    const controller = new globalThis.AbortController();
    controller.abort(Object.assign(new Error('parti'), { name: 'AbortError' }));
    const call = createToolCaller({ tools: [tool()], signal: controller.signal });
    await expect(call({ id: 'a', name: 'read_bible', args: {} })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runToolLoop', () => {
  /* Un modèle qui joue un script : chaque tour donne la réponse suivante. */
  function scripted(...answers) {
    const seen = [];
    const turn = async (request) => {
      seen.push({ ...request, messages: globalThis.structuredClone(request.messages) });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(request) : { text: null, toolCalls: [], ...next };
    };
    return { turn, seen };
  }
  const callTool = createToolCaller({ tools: [tool()] });

  test('a question answered at once calls no tool', async () => {
    const { turn, seen } = scripted({ text: 'Prie.' });
    const messages = [{ role: 'user', text: 'Comment ?' }];
    expect(await runToolLoop({ system: 's', messages, tools: toolSpecs([tool()]), turn, callTool })).toEqual({ text: 'Prie.', turns: 1 });
    expect(seen[0].tools).toHaveLength(1);
  });

  test('tools asked together run together; their results come back in order', async () => {
    let running = 0;
    let most = 0;
    const slow = (name) => tool({ name, run: async () => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 20)); running -= 1; return { data: name }; } });
    const { turn, seen } = scripted({ toolCalls: [{ id: 'a', name: 'first', args: {} }, { id: 'b', name: 'second', args: {} }] }, { text: 'Les deux.' });
    const messages = [{ role: 'user', text: 'q' }];
    await runToolLoop({ system: 's', messages, turn, callTool: createToolCaller({ tools: [slow('first'), slow('second')] }) });
    expect(most).toBe(2);
    expect(seen[1].messages.slice(1)).toEqual([
      { role: 'assistant', text: null, toolCalls: [{ id: 'a', name: 'first', args: {} }, { id: 'b', name: 'second', args: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'first', result: 'first' },
      { role: 'tool', toolCallId: 'b', name: 'second', result: 'second' }
    ]);
  });

  test('out of turns: a last turn without tools, told to answer with what it has', async () => {
    const call = { toolCalls: [{ id: 'a', name: 'read_bible', args: { reference: 'Jean 3:16' } }] };
    const { turn, seen } = scripted(call, call, { text: 'Voici.' });
    const result = await runToolLoop({ system: 's', messages: [], turn, callTool, maxTurns: 2, finalInstruction: 'Answer now.' });
    expect(result).toEqual({ text: 'Voici.', turns: 3 });
    expect(seen[2].tools).toEqual([]);
    expect(seen[2].system).toBe('s\nAnswer now.');
  });

  test('out of time: the same last turn', async () => {
    let clock = 0;
    const call = { toolCalls: [{ id: 'a', name: 'read_bible', args: {} }] };
    const { turn, seen } = scripted(() => { clock += 61_000; return { text: null, ...call }; }, { text: 'Vite.' });
    expect((await runToolLoop({ system: 's', messages: [], turn, callTool, now: () => clock })).text).toBe('Vite.');
    expect(seen).toHaveLength(2);
    expect(seen[1].tools).toEqual([]);
  });

  test('a turn with neither text nor tools is no answer', async () => {
    const { turn } = scripted({ text: '', model: 'groq:x' });
    await expect(runToolLoop({ system: 's', messages: [], turn, callTool })).rejects.toMatchObject({ code: 'AI_NO_ANSWER', message: 'groq:x gave no text.' });
  });

  test('when the person leaves, the loop stops', async () => {
    const controller = new globalThis.AbortController();
    const { turn } = scripted(() => { controller.abort(Object.assign(new Error('parti'), { name: 'AbortError' })); return { text: null, toolCalls: [{ id: 'a', name: 'read_bible', args: {} }] }; }, { text: 'Trop tard.' });
    await expect(runToolLoop({ system: 's', messages: [], turn, callTool: createToolCaller({ tools: [tool()], signal: controller.signal }), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
