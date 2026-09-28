const {
  resumeConversation,
  createTranscriptRecorder,
  consolidateAfterCall
} = require('../src');
const item = {
  id: 'one',
  userId: 'u',
  updatedAt: 100,
  turns: [{
    who: 'person',
    text: 'hello'
  }]
};
test('resumes requested fresh conversation', async () => {
  expect(await resumeConversation({
    store: {
      get: async () => item
    },
    userId: 'u',
    requestedId: 'one',
    now: () => 100
  })).toEqual({
    id: 'one',
    turns: item.turns
  });
});
test('resumes latest fresh conversation', async () => {
  expect((await resumeConversation({
    store: {
      latest: async () => item
    },
    userId: 'u',
    now: () => 100
  })).id).toBe('one');
});
test('resumed history is bounded to the most recent turns', async () => {
  const result = await resumeConversation({
    store: { latest: async () => ({ ...item, turns: Array.from({ length: 20 }, (_, index) => ({ text: String(index) })) }) },
    userId: 'u', now: () => 100, maxTurns: 4
  });
  expect(result.turns.map((turn) => turn.text)).toEqual(['16', '17', '18', '19']);
});
test.each([['different owner', {
  userId: 'other'
}, 100], ['stale', {}, 1800101], ['future', {}, 99], ['invalid time', {
  updatedAt: null
}, 100]])('rejects %s conversation', async (_name, change, time) => {
  expect(await resumeConversation({
    store: {
      get: async () => ({
        ...item,
        ...change
      })
    },
    userId: 'u',
    requestedId: 'one',
    now: () => time
  })).toBeNull();
});
test('missing store degrades to fresh conversation', async () => {
  expect(await resumeConversation({
    userId: 'u',
    now: () => 100
  })).toBeNull();
});
test('failed conversation lookup degrades to fresh conversation', async () => {
  expect(await resumeConversation({
    store: {
      latest: async () => {
        throw new Error('offline');
      }
    },
    userId: 'u',
    now: () => 100
  })).toBeNull();
});
test('null latest conversation is fresh', async () => {
  expect(await resumeConversation({
    store: {
      latest: async () => null
    },
    userId: 'u',
    now: () => 100
  })).toBeNull();
});
test('recorder waits for user before creation', async () => {
  const store = {
    create: jest.fn(),
    append: jest.fn()
  };
  const r = createTranscriptRecorder({
    store,
    userId: 'u',
    now: () => 1
  });
  await r.record([{
    who: 'assistant',
    text: 'hello'
  }]);
  expect(store.create).not.toHaveBeenCalled();
});
test('complete-only recorder waits for an assistant reply', async () => {
  const store = {
    create: jest.fn(async () => 'c'),
    append: jest.fn()
  };
  const recorder = createTranscriptRecorder({
    store,
    userId: 'u',
    now: () => 1,
    completeOnly: true
  });
  const turns = [{
    who: 'person',
    text: 'question'
  }];
  await recorder.record(turns);
  expect(store.create).not.toHaveBeenCalled();
  await recorder.record([...turns, {
    who: 'assistant',
    text: 'answer'
  }]);
  expect(store.append.mock.calls[0][2]).toHaveLength(2);
});
test('deferred exchange is saved when another question begins or the call ends', async () => {
  const store = { create: jest.fn(async () => 'c'), append: jest.fn() };
  const recorder = createTranscriptRecorder({
    store, userId: 'u', now: () => 1,
    completeOnly: true, deferLatestExchange: true
  });
  const first = [
    { who: 'person', text: 'one' },
    { who: 'assistant', text: 'answer one' }
  ];
  await recorder.record(first);
  expect(store.append).not.toHaveBeenCalled();
  await recorder.record([...first, { who: 'person', text: 'two' }]);
  expect(store.append.mock.calls[0][2]).toHaveLength(2);
  await recorder.record([...first, { who: 'person', text: 'two' }, { who: 'assistant', text: 'answer two' }], { final: true });
  expect(store.append.mock.calls[1][2]).toHaveLength(2);
});
test('recorder creates and appends one turn once', async () => {
  const store = {
    create: async () => 'c',
    append: jest.fn()
  };
  const r = createTranscriptRecorder({
    store,
    userId: 'u',
    now: () => 1
  });
  const turns = [{
    who: 'person',
    text: 'hello'
  }];
  await r.record(turns);
  await r.record(turns);
  expect(store.append).toHaveBeenCalledTimes(1);
  expect(await r.kept()).toBe('c');
});
test('recorder trims and caps text', async () => {
  const store = {
    create: async () => 'c',
    append: jest.fn()
  };
  const r = createTranscriptRecorder({
    store,
    userId: 'u',
    now: () => 1,
    maxChars: 3
  });
  await r.record([{
    who: 'person',
    text: ' abcdef '
  }]);
  expect(store.append.mock.calls[0][2][0].text).toBe('abc');
});
test('recorder preserves injected tool annotations with the assistant turn', async () => {
  const append = jest.fn();
  const recorder = createTranscriptRecorder({
    store: {
      create: async () => 'c',
      append
    },
    userId: 'u',
    now: () => 1
  });
  await recorder.record([{
    who: 'person',
    text: 'question'
  }, {
    who: 'assistant',
    text: 'answer',
    annotations: [{
      ref: 'r'
    }]
  }]);
  expect(append.mock.calls[0][2][1].annotations).toEqual([{
    ref: 'r'
  }]);
});
test('recorder reuses prior id', async () => {
  const store = {
    create: jest.fn(),
    append: jest.fn()
  };
  const r = createTranscriptRecorder({
    store,
    userId: 'u',
    conversationId: 'old',
    now: () => 1
  });
  await r.record([{
    who: 'person',
    text: 'hello'
  }]);
  expect(store.create).not.toHaveBeenCalled();
  expect(await r.kept()).toBe('old');
});
test('recorder preserves serialized append order', async () => {
  const calls = [];
  const store = {
    create: async () => 'c',
    append: async (_id, _user, turns) => {
      calls.push(turns[0].text);
    }
  };
  const r = createTranscriptRecorder({
    store,
    userId: 'u',
    now: () => 1
  });
  const one = r.record([{
    who: 'person',
    text: 'one'
  }]);
  const two = r.record([{
    who: 'person',
    text: 'one'
  }, {
    who: 'assistant',
    text: 'two'
  }]);
  await Promise.all([one, two]);
  expect(calls).toEqual(['one', 'two']);
});
test('recorder retries unsaved turns after a failed append', async () => {
  const append = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce();
  const r = createTranscriptRecorder({
    store: {
      create: async () => 'c',
      append
    },
    userId: 'u',
    now: () => 1
  });
  const turns = [{
    who: 'person',
    text: 'one'
  }];
  await expect(r.record(turns)).rejects.toThrow('offline');
  await r.record(turns);
  expect(append).toHaveBeenCalledTimes(2);
});
test('consolidation invokes memory signature', async () => {
  const memory = {
    consolidate: jest.fn(async () => ({
      status: 'ok'
    }))
  };
  expect(await consolidateAfterCall(memory, {
    userId: 'u'
  }, [{
    who: 'person',
    text: 'hello'
  }], 'c')).toEqual({
    status: 'ok'
  });
  expect(memory.consolidate).toHaveBeenCalledWith({
    userId: 'u'
  }, {
    transcript: [{
      who: 'person',
      text: 'hello'
    }],
    ref: 'c'
  });
});
test.each([null, [], ''])('consolidation skips missing prerequisite %s', async value => {
  const result = await consolidateAfterCall(null, {}, value || [], null);
  expect(result.status).toBe('skipped');
});
test('consolidation failure is contained', async () => {
  expect((await consolidateAfterCall({
    consolidate: async () => {
      throw new Error();
    }
  }, {}, [{
    text: 'hello'
  }], 'c')).status).toBe('failed');
});
