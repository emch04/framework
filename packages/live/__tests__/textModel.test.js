const {
  parseSse,
  createGeminiTextModel,
  createTextThinker
} = require('../src');
async function* chunks(...values) {
  for (const value of values) yield new globalThis.TextEncoder().encode(value);
}
test('SSE parser handles split events', async () => {
  const events = [];
  for await (const event of parseSse(chunks('data: {"a":', '1}\n\n'))) events.push(event);
  expect(events).toEqual([{
    a: 1
  }]);
});
test('SSE parser skips malformed events', async () => {
  const events = [];
  for await (const event of parseSse(chunks('data: no\n\ndata: {"ok":true}\n\n'))) events.push(event);
  expect(events).toEqual([{
    ok: true
  }]);
});
test('SSE parser handles final event without blank line', async () => {
  const events = [];
  for await (const event of parseSse(chunks('data: {"end":true}'))) events.push(event);
  expect(events).toEqual([{
    end: true
  }]);
});
const clock = {
  now: () => 0,
  setTimeout,
  clearTimeout
};
test('Gemini text model streams text and retains parts', async () => {
  const fetch = jest.fn(async () => ({
    ok: true,
    body: chunks('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n')
  }));
  const model = createGeminiTextModel({
    fetch,
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock
  });
  const pieces = [];
  const result = await model.generate({
    instructions: 'i',
    contents: [],
    onText: text => pieces.push(text)
  });
  expect(pieces).toEqual(['hello']);
  expect(result.parts).toEqual([{
    text: 'hello'
  }]);
  expect(fetch.mock.calls[0][0]).toContain('/models/m:streamGenerateContent');
});
test('Gemini text model uses key header and optional tools', async () => {
  const fetch = jest.fn(async () => ({
    ok: true,
    body: chunks('')
  }));
  const model = createGeminiTextModel({
    fetch,
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock
  });
  await model.generate({
    instructions: 'i',
    contents: [],
    declarations: [{
      name: 'read'
    }]
  });
  expect(fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('fake');
  expect(JSON.parse(fetch.mock.calls[0][1].body).tools[0].functionDeclarations).toHaveLength(1);
});
test('rejected text candidate falls back', async () => {
  let tries = 0;
  const fetch = async () => {
    tries += 1;
    return tries === 1 ? {
      ok: false,
      status: 429
    } : {
      ok: true,
      body: chunks('data: {"candidates":[{"content":{"parts":[{"text":"yes"}]}}]}\n\n')
    };
  };
  const model = createGeminiTextModel({
    fetch,
    candidates: [{
      model: 'm',
      key: 'fake1'
    }, {
      model: 'm',
      key: 'fake2'
    }],
    clock
  });
  expect((await model.generate({
    instructions: 'i',
    contents: []
  })).parts[0].text).toBe('yes');
});
test('all rejected text candidates return code', async () => {
  const model = createGeminiTextModel({
    fetch: async () => ({
      ok: false,
      status: 429
    }),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock
  });
  await expect(model.generate({
    instructions: 'i',
    contents: []
  })).rejects.toMatchObject({
    code: 'TEXT_MODEL_UNAVAILABLE'
  });
});
test('text thinker sends prior turns and streams result', async () => {
  const inputs = [];
  const model = {
    generate: async input => {
      inputs.push(JSON.parse(JSON.stringify(input.contents)));
      input.onText('hello');
      return {
        parts: [{
          text: 'hello'
        }]
      };
    }
  };
  const thinker = createTextThinker({
    model,
    instructions: 'i',
    tools: {
      call: async () => ({})
    },
    earlier: [{
      who: 'person',
      text: 'prior'
    }]
  });
  expect((await thinker.respond('question')).text).toBe('hello');
  expect(inputs[0]).toHaveLength(2);
});
test('text thinker calls tool and carries signature', async () => {
  const calls = [];
  const inputs = [];
  const model = {
    generate: async input => {
      inputs.push(JSON.parse(JSON.stringify(input.contents)));
      return inputs.length === 1 ? {
        parts: [{
          functionCall: {
            id: 'one',
            name: 'read'
          },
          thoughtSignature: 'sig'
        }]
      } : {
        parts: [{
          text: 'done'
        }]
      };
    }
  };
  const thinker = createTextThinker({
    model,
    instructions: 'i',
    tools: {
      call: async call => {
        calls.push(call.name);
        return {
          value: 1
        };
      }
    }
  });
  await thinker.respond('question');
  expect(calls).toEqual(['read']);
  expect(inputs[1][1].parts[0].thoughtSignature).toBe('sig');
  expect(inputs[1][2].parts[0].functionResponse.response.result.value).toBe(1);
});
test('text thinker enforces tool round cap', async () => {
  const model = {
    generate: async () => ({
      parts: [{
        functionCall: {
          name: 'read'
        }
      }]
    })
  };
  const thinker = createTextThinker({
    model,
    instructions: 'i',
    tools: {
      call: async () => ({})
    },
    maxTurns: 2
  });
  expect((await thinker.respond('question')).limitReached).toBe(true);
});
test('text thinker undo removes last question', async () => {
  const thinker = createTextThinker({
    model: {
      generate: async () => ({
        parts: [{
          text: 'answer'
        }]
      })
    },
    instructions: 'i',
    tools: {
      call: async () => ({})
    }
  });
  await thinker.respond('question');
  thinker.undoLast();
  expect(thinker.history).toEqual([]);
});
test('nonstreaming text model still emits answer', async () => {
  const pieces = [];
  const thinker = createTextThinker({
    model: {
      generate: async () => ({
        parts: [{
          text: 'answer'
        }]
      })
    },
    instructions: 'i',
    tools: {
      call: async () => ({})
    }
  });
  expect((await thinker.respond('question', {
    onText: piece => pieces.push(piece)
  })).text).toBe('answer');
  expect(pieces).toEqual(['answer']);
});
test('text thinker removes first model turn from prior history', () => {
  const thinker = createTextThinker({
    model: {
      generate: async () => ({
        parts: []
      })
    },
    instructions: 'i',
    tools: {
      call: async () => ({})
    },
    earlier: [{
      who: 'assistant',
      text: 'greeting'
    }, {
      who: 'person',
      text: 'question'
    }]
  });
  expect(thinker.history[0].role).toBe('user');
});
