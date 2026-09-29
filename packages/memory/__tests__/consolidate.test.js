const { createMemoryStore, parseModelJson, defaultConsolidationPrompt, patternRule } = require('../src');
const { setup, A } = require('./helpers');

const answerWith = (value) => jest.fn(async () => (typeof value === 'string' ? value : JSON.stringify(value)));

describe('consolidate', () => {
  test('adds durable facts as unseen background memories and returns the summary', async () => {
    const llm = answerWith('```json\n{"facts":[{"text":"Runs every morning","kind":"Fact","importance":"4"}],"summary":"Talked about  sport."}\n```');
    const { memory } = setup({ llm });
    const result = await memory.consolidate(A, { transcript: [{ role: 'user', text: 'I run every morning' }], ref: 'c1', role: 'member' });
    expect(result).toMatchObject({ status: 'done', added: 1, corrected: 0, refused: 0, summary: 'Talked about sport.' });
    const [unseen] = await memory.listUnseen(A);
    expect(unseen).toMatchObject({ text: 'Runs every morning', kind: 'fact', importance: 4, role: 'member' });
    expect(unseen.source).toMatchObject({ channel: 'background', ref: 'c1' });
  });

  test('is shown what is known (masked) and corrects it instead of doubling; an unknown id is ignored', async () => {
    const llm = jest.fn();
    const { memory } = setup({ llm, mask: (text) => text.replace('Lyon', '[CITY]') });
    const kept = await memory.remember(A, { text: 'Lives in Lyon', kind: 'fact', importance: 4 });
    llm.mockImplementation(async () => JSON.stringify({
      facts: [],
      corrections: [{ id: kept.memory.id, text: 'Lives in Paris' }, { id: 'someone-else', text: 'hacked' }],
      summary: 'Moved.'
    }));
    const result = await memory.consolidate(A, { transcript: 'I moved to Paris from Lyon', ref: 'c2' });
    expect(result).toMatchObject({ status: 'done', corrected: 1 });
    const request = llm.mock.calls[0][0];
    expect(request.prompt).toContain(`${kept.memory.id}: Lives in [CITY]`);
    expect(request.prompt).toContain('I moved to Paris from [CITY]');
    expect(request.prompt).not.toContain('Lyon');
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Lives in Paris']);
    const [current] = await memory.list(A);
    expect(current).toMatchObject({ kind: 'fact', importance: 4 });
    expect(await memory.undo(A, current.id)).toBe(true);
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Lives in Lyon']);
  });

  test('a correction keeps a name the memory already carried', async () => {
    const llm = jest.fn();
    const { memory } = setup({ llm, namesOf: async () => ['José Ortega'] });
    const kept = await memory.remember(A, { text: 'Tutors José Ortega', kind: 'fact', personName: 'José Ortega' });
    llm.mockResolvedValue(JSON.stringify({ facts: [{ text: 'Coaches José Ortega', kind: 'fact', importance: 3 }], corrections: [{ id: kept.memory.id, text: 'Tutors José Ortega in maths' }] }));
    const result = await memory.consolidate(A, { transcript: 'now maths too' });
    expect(result).toMatchObject({ status: 'done', corrected: 1, added: 0, refused: 1 });
  });

  test('content rules apply; an injected explicit check lets a requested fact through', async () => {
    const llm = answerWith({ facts: [{ text: 'Has diabetes', kind: 'fact', importance: 4 }, { text: 'Has asthma', kind: 'fact', importance: 4 }] });
    const rules = [patternRule({ code: 'sensitive', patterns: [/diabetes|asthma/i], allowWhenExplicit: true })];
    const isExplicitFact = jest.fn(async (fact) => fact.text.includes('diabetes'));
    const { memory } = setup({ llm, rules, isExplicitFact });
    const result = await memory.consolidate(A, { transcript: 'Remember I have diabetes. I also have asthma.' });
    expect(result).toMatchObject({ added: 1, refused: 1 });
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Has diabetes']);
  });

  test('once per ref; paused marks the conversation done and learns nothing, even after the pause', async () => {
    const llm = answerWith({ facts: [{ text: 'Likes tea', kind: 'preference', importance: 3 }] });
    const { memory } = setup({ llm });
    expect((await memory.consolidate(A, { transcript: 'tea', ref: 'c1' })).status).toBe('done');
    expect((await memory.consolidate(A, { transcript: 'tea', ref: 'c1' })).status).toBe('already');
    await memory.setPaused(A, true);
    expect((await memory.consolidate(A, { transcript: 'coffee', ref: 'c2' })).status).toBe('paused');
    await memory.setPaused(A, false);
    expect((await memory.consolidate(A, { transcript: 'coffee', ref: 'c2' })).status).toBe('already');
    expect(llm).toHaveBeenCalledTimes(1);
  });

  test('never throws: a model failure or bad JSON is "failed" and the ref is released for a retry', async () => {
    const llm = jest.fn().mockRejectedValueOnce(new Error('model down')).mockResolvedValueOnce('no json here').mockResolvedValueOnce('{"facts":[]}');
    const store = createMemoryStore();
    const { memory } = setup({ llm, store });
    expect((await memory.consolidate(A, { transcript: 'hello', ref: 'c1' })).status).toBe('failed');
    expect((await memory.consolidate(A, { transcript: 'hello', ref: 'c1' })).status).toBe('failed');
    expect((await memory.consolidate(A, { transcript: 'hello', ref: 'c1' })).status).toBe('done');
    expect((await memory.consolidate(null, { transcript: 'hello' })).status).toBe('failed');
  });

  test('without a model it is unavailable; an empty transcript asks nothing', async () => {
    expect((await setup().memory.consolidate(A, { transcript: 'x' })).status).toBe('unavailable');
    const llm = jest.fn();
    expect((await setup({ llm }).memory.consolidate(A, { transcript: '   ' })).status).toBe('empty');
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('model output and prompt', () => {
  test('parseModelJson reads fenced or wrapped JSON and throws on anything else', () => {
    expect(parseModelJson('Sure! ```json\n{"a":1}\n``` done')).toEqual({ a: 1 });
    expect(parseModelJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
    expect(() => parseModelJson('nothing')).toThrow();
    expect(() => parseModelJson('[1,2]')).toThrow();
  });

  test('the default prompt lists the kinds, the known memories and the language code', () => {
    const { system, prompt } = defaultConsolidationPrompt({ kinds: ['goal', 'fact'], known: [{ id: 'm1', text: 'x' }], transcript: 'hi', language: 'fr', role: 'coach' });
    expect(system).toContain('goal|fact');
    expect(system).toContain('"fr"');
    expect(system).toContain('coach');
    expect(prompt).toContain('m1: x');
    expect(prompt).toContain('hi');
  });
});

describe('readExtraction: the answers models really give', () => {
  const { readExtraction } = require('../src');
  const texts = (extraction) => extraction.facts.map((fact) => [fact.text, fact.kind, fact.importance]);

  test('a code fence or a sentence around the JSON, raw line breaks in strings, a trailing comma, a bare list', () => {
    const fenced = readExtraction('Voici :\n```json\n{"facts":[{"text":"Prépare la réunion.","kind":"preference","importance":3}],"corrections":[],"summary":"Préparation."}\n```\nBonne journée.');
    expect(texts(fenced)).toEqual([['Prépare la réunion.', 'preference', 3]]);
    expect(fenced.summary).toBe('Préparation.');

    const raw = readExtraction('{"facts":[{"text":"Aime les\nPsaumes.","kind":"feeling","importance":2},],"summary":"Un\tmoment."}');
    expect(texts(raw)).toEqual([['Aime les Psaumes.', 'feeling', 2]]);
    expect(raw.summary).toBe('Un moment.');

    expect(texts(readExtraction('[{"text":"Reads daily.","kind":"fact","importance":4}]'))).toEqual([['Reads daily.', 'fact', 4]]);
  });

  test('facts as strings, and the other names for the same things', () => {
    const read = readExtraction(JSON.stringify({
      memories: ['Goes out on Saturday.', { fact: 'Has a sister.', type: 'person', priority: '4' }, { content: 'Moved.', category: 'event' }, { text: '   ' }, 42],
      updates: [{ id: ' m1 ', memory: 'Now on Sunday.' }, { id: 'm2', text: '' }, { text: 'no id' }]
    }));
    expect(texts(read)).toEqual([['Goes out on Saturday.', undefined, undefined], ['Has a sister.', 'person', '4'], ['Moved.', 'event', undefined]]);
    expect(read.corrections).toEqual([{ id: 'm1', text: 'Now on Sunday.', kind: undefined, importance: undefined }]);
    expect(read.summary).toBeNull();
  });

  test('an answer cut short keeps each whole fact before the cut, and a summary written before it', () => {
    const cut = readExtraction('{"facts":[{"text":"Moved to Lyon.","kind":"event","importance":4},{"text":"Wants to learn Lingala","kind":"go');
    expect(texts(cut)).toEqual([['Moved to Lyon.', 'event', 4]]);
    const afterSummary = readExtraction('{"summary":"Talked \\"about\\" moving.","facts":[{"text":"Moved to Lyon.","kind":"event","importance":4},{"te');
    expect(afterSummary.summary).toBe('Talked "about" moving.');
    expect(afterSummary.facts).toHaveLength(1);
  });

  test('nothing readable throws: a failed run, never "nothing to remember"', () => {
    expect(() => readExtraction('Here is the memory. It is not JSON.')).toThrow(SyntaxError);
    expect(() => readExtraction('')).toThrow(SyntaxError);
    expect(() => readExtraction(undefined)).toThrow(SyntaxError);
  });

  test('parseModelJson also repairs raw line breaks and trailing commas, and still refuses what is not an object', () => {
    expect(parseModelJson('{"a":"x\ny",}')).toEqual({ a: 'x\ny' });
    expect(() => parseModelJson('[1,2]')).toThrow();
  });
});

describe('consolidate: failures with a reason, isolated writes, the transcript window', () => {
  test('lenient answers are consolidated: strings, aliases, kind and importance as models write them', async () => {
    const llm = answerWith('{"memories":["Likes tea", {"fact":"Runs daily","type":"GOAL","priority":"5"}],"summary":"Tea."}');
    const { memory } = setup({ llm, defaultKind: 'fact' });
    const result = await memory.consolidate(A, { transcript: 'tea and running' });
    expect(result).toMatchObject({ status: 'done', added: 2, proposed: 2, failed: 0, summary: 'Tea.' });
    expect((await memory.list(A)).map((m) => [m.text, m.kind, m.importance]).sort()).toEqual([['Likes tea', 'fact', 3], ['Runs daily', 'goal', 5]]);
  });

  test('the model failing, or answering nothing readable, says why and hands back the error', async () => {
    const down = new Error('quota');
    const llm = jest.fn().mockRejectedValueOnce(down).mockResolvedValueOnce('I could not find anything.');
    const { memory } = setup({ llm });
    expect(await memory.consolidate(A, { transcript: 'hello' })).toMatchObject({ status: 'failed', reason: 'model', error: down });
    expect(await memory.consolidate(A, { transcript: 'hello' })).toMatchObject({ status: 'failed', reason: 'unreadable' });
    expect(await memory.consolidate(null, { transcript: 'hello' })).toMatchObject({ status: 'failed', reason: 'invalid_where' });
  });

  test('a write that fails never loses the others; the run is failed with the counts, and the ref is released', async () => {
    const store = createMemoryStore();
    const realInsert = store.insert;
    store.insert = async (record) => {
      if (record.text.includes('boom')) throw new Error('disk full');
      return realInsert(record);
    };
    const llm = answerWith({ facts: [{ text: 'Likes tea', kind: 'preference' }, { text: 'boom', kind: 'fact' }, { text: 'Likes cake', kind: 'preference' }], summary: 'Snacks.' });
    const { memory } = setup({ llm, store });
    const result = await memory.consolidate(A, { transcript: 'snacks', ref: 'c1' });
    expect(result).toMatchObject({ status: 'failed', reason: 'store', added: 2, failed: 1, proposed: 3, summary: 'Snacks.' });
    expect(result.error.message).toBe('disk full');
    expect((await memory.list(A)).map((m) => m.text).sort()).toEqual(['Likes cake', 'Likes tea']);
    store.insert = realInsert;
    expect((await memory.consolidate(A, { transcript: 'snacks', ref: 'c1' })).status).toBe('done');
  });

  test('a transcript over transcriptMax keeps its start, or its end when asked (what is new)', async () => {
    const seen = [];
    const llm = jest.fn(async (request) => { seen.push(request.prompt); return '{"facts":[]}'; });
    const transcript = `${'a'.repeat(30)}${'b'.repeat(30)}`;
    await setup({ llm, transcriptMax: 40 }).memory.consolidate(A, { transcript });
    await setup({ llm, transcriptMax: 40, transcriptKeep: 'end' }).memory.consolidate(A, { transcript });
    expect(seen[0]).toContain('a'.repeat(30) + 'b'.repeat(10));
    expect(seen[0]).not.toContain('b'.repeat(11));
    expect(seen[1]).toContain('a'.repeat(10) + 'b'.repeat(30));
    expect(seen[1]).not.toContain('a'.repeat(11));
  });
});
