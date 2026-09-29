const {
  EventEmitter
} = require('events');
const {
  geminiSetup,
  geminiEvents,
  createGeminiLiveAdapter
} = require('../src');
function fakeFactory(created) {
  return url => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.url = url;
    ws.sent = [];
    ws.send = data => ws.sent.push(JSON.parse(data));
    ws.close = () => {
      ws.readyState = 3;
      ws.emit('close', 1000);
    };
    ws.terminate = ws.close;
    created.push(ws);
    Promise.resolve().then(() => {
      ws.emit('open');
      ws.emit('message', JSON.stringify({
        setupComplete: {}
      }));
    });
    return ws;
  };
}
test('setup includes model, audio, transcripts, compression', () => {
  const setup = geminiSetup({
    model: 'm',
    voice: 'v',
    instructions: 'i'
  }).setup;
  expect(setup.model).toBe('models/m');
  expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
  expect(setup.inputAudioTranscription).toEqual({});
  expect(setup.contextWindowCompression).toBeDefined();
});
test('setup includes tool declarations', () => {
  expect(geminiSetup({
    model: 'm',
    instructions: 'i',
    declarations: [{
      name: 'read'
    }]
  }).setup.tools[0].functionDeclarations).toHaveLength(1);
});
test('setup supports resumption handle', () => {
  expect(geminiSetup({
    model: 'm',
    instructions: 'i',
    handle: 'h'
  }).setup.sessionResumption.handle).toBe('h');
});
test('confidential setup requests text', () => {
  expect(geminiSetup({
    model: 'm',
    instructions: 'i',
    mode: 'confidential'
  }).setup.generationConfig.responseModalities).toEqual(['TEXT']);
});
test.each([['goAway', {
  goAway: {}
}], ['heard', {
  serverContent: {
    inputTranscription: {
      text: 'hi'
    }
  }
}], ['said', {
  serverContent: {
    outputTranscription: {
      text: 'hello'
    }
  }
}], ['turn', {
  serverContent: {
    turnComplete: true
  }
}], ['interrupted', {
  serverContent: {
    interrupted: true
  }
}], ['audio', {
  serverContent: {
    modelTurn: {
      parts: [{
        inlineData: {
          data: 'AA=='
        }
      }]
    }
  }
}], ['text', {
  serverContent: {
    modelTurn: {
      parts: [{
        text: 'hello'
      }]
    }
  }
}]])('parses %s event', (type, message) => {
  expect(geminiEvents(message)[0].type).toBe(type);
});
test('adapter opens and sends setup without exposing key to callbacks', async () => {
  const created = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i'
  });
  expect(line.model).toBe('m');
  expect(created[0].sent[0].setup.model).toBe('models/m');
  line.close();
});
test('adapter sends audio, text, image, mute', async () => {
  const created = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i'
  });
  line.sendAudio('AA==');
  line.sendText('hello');
  line.sendImage('image');
  line.mute();
  expect(created[0].sent.map(x => Object.keys(x)[0])).toEqual(['setup', 'realtimeInput', 'clientContent', 'realtimeInput', 'realtimeInput']);
  line.close();
});
test('adapter relays model audio', async () => {
  const created = [];
  const events = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i',
    onEvent: event => events.push(event)
  });
  created[0].emit('message', JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{
          inlineData: {
            data: 'AA=='
          }
        }]
      }
    }
  }));
  expect(events.some(event => event.type === 'audio')).toBe(true);
  line.close();
});
test('adapter routes tool response', async () => {
  const created = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i',
    tools: {
      declarations: [],
      call: async () => ({
        ok: true
      })
    }
  });
  created[0].emit('message', JSON.stringify({
    toolCall: {
      functionCalls: [{
        id: 'one',
        name: 'read',
        args: {}
      }]
    }
  }));
  await Promise.resolve();
  expect(created[0].sent.at(-1).toolResponse.functionResponses[0].response.result.ok).toBe(true);
  line.close();
});
test('adapter reports tool activity', async () => {
  const created = [];
  const events = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i',
    tools: {
      declarations: [],
      call: async () => ({})
    },
    onEvent: event => events.push(event.type)
  });
  created[0].emit('message', JSON.stringify({
    toolCall: {
      functionCalls: [{
        id: 'one',
        name: 'read'
      }]
    }
  }));
  await Promise.resolve();
  expect(events).toEqual(['ready', 'tool', 'tool_done']);
  line.close();
});
test('goAway resumes same candidate with handle', async () => {
  const created = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'm',
      key: 'fake'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i'
  });
  created[0].emit('message', JSON.stringify({
    sessionResumptionUpdate: {
      newHandle: 'resume'
    }
  }));
  created[0].emit('message', JSON.stringify({
    goAway: {}
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(created).toHaveLength(2);
  expect(created[1].sent[0].setup.sessionResumption.handle).toBe('resume');
  line.close();
});
test('provider close switches to another candidate', async () => {
  const created = [];
  const events = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'one',
      key: 'fake-one'
    }, {
      model: 'two',
      key: 'fake-two'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const line = await adapter.connect({
    instructions: 'i',
    onEvent: event => events.push(event)
  });
  created[0].emit('close', 1008);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(created[1].sent[0].setup.model).toBe('models/two');
  expect(events.at(-1).reconnected).toBe(true);
  line.close();
});
test('switching candidates sends the latest protected call history', async () => {
  const created = [];
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'one',
      key: 'fake-one'
    }, {
      model: 'two',
      key: 'fake-two'
    }],
    clock: {
      now: () => 0,
      setTimeout,
      clearTimeout
    }
  });
  const turns = [{
    who: 'person',
    text: 'first'
  }];
  const line = await adapter.connect({
    instructions: 'i',
    getHistory: () => turns
  });
  turns.push({
    who: 'assistant',
    text: 'later'
  });
  created[0].emit('close', 1008);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(created[1].sent.some(message => message.clientContent?.turns[0].parts[0].text.includes('later'))).toBe(true);
  line.close();
});
test('image input is paced and bounded', async () => {
  const created = [];
  let time = 0;
  const adapter = createGeminiLiveAdapter({
    websocketFactory: fakeFactory(created),
    candidates: [{
      model: 'one',
      key: 'fake-one'
    }],
    clock: {
      now: () => time,
      setTimeout,
      clearTimeout
    },
    maxImageBytes: 12,
    imageEveryMs: 1000
  });
  const line = await adapter.connect({
    instructions: 'i'
  });
  expect(line.sendImage('small')).toBe(true);
  expect(line.sendImage('again')).toBe(false);
  time = 1000;
  expect(line.sendImage('x'.repeat(100))).toBe(false);
  expect(created[0].sent.filter(message => message.realtimeInput?.video)).toHaveLength(1);
  line.close();
});

describe('a call on the keys of a host that lives with its quotas', () => {
  const clock = { now: () => 0, setTimeout, clearTimeout };
  const later = () => new Promise(resolve => setTimeout(resolve, 0));
  /* Google's side: `answer(socket, index)` gives 'refuse' (closed before setup with a reason) or lets it open. */
  function google(answer = () => 'open') {
    const created = [];
    const websocketFactory = url => {
      const ws = new EventEmitter();
      ws.readyState = 1;
      ws.key = new URL(url).searchParams.get('key');
      ws.sent = [];
      ws.send = data => ws.sent.push(JSON.parse(data));
      ws.close = () => { ws.readyState = 3; };
      ws.terminate = ws.close;
      created.push(ws);
      Promise.resolve().then(() => {
        ws.emit('open');
        const verdict = answer(ws, created.length);
        if (Array.isArray(verdict)) ws.emit('close', ...verdict);
        else if (verdict !== 'silent') ws.emit('message', JSON.stringify({ setupComplete: {} }));
      });
      return ws;
    };
    return { created, websocketFactory };
  }
  const candidates = [{ model: 'best', key: 'one' }, { model: 'best', key: 'two' }, { model: 'older', key: 'one' }, { model: 'older', key: 'two' }];

  test('the candidates may be a function, asked again at every change of line', async () => {
    const { created, websocketFactory } = google();
    let keys = [{ model: 'm', key: 'first' }];
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates: () => keys, clock });
    const line = await adapter.connect({ instructions: 'i' });
    expect(created[0].key).toBe('first');
    keys = [{ model: 'm', key: 'rotated' }];
    created[0].emit('close', 1008, Buffer.from('policy'));
    await later();
    expect(created.map(socket => socket.key)).toEqual(['first', 'rotated']);
    line.close();
  });
  test('a session cut for a quota moves to the next key with what was said, told and not asked; the cut key rests for the next call', async () => {
    const { created, websocketFactory } = google();
    const turns = [{ who: 'person', text: 'Pourquoi prier ?' }, { who: 'assistant', text: 'Pour parler à Jéhovah.' }];
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i', getHistory: () => turns });
    created[0].emit('message', JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } }));
    created[0].emit('close', 1011, Buffer.from('Resource has been exhausted (e.g. check quota).'));
    await later();
    expect(created[1].key).toBe('two');
    expect(created[1].sent[0].setup.sessionResumption).toEqual({});
    expect(created[1].sent[1].clientContent.turns[0].parts[0].text).toBe('person: Pourquoi prier ?\nassistant: Pour parler à Jéhovah.');
    expect(created[1].sent[1].clientContent.turnComplete).toBe(false);
    /* Google cuts the new session without a handle of its own: the old handle is not carried over to another key. */
    created[1].emit('message', JSON.stringify({ goAway: {} }));
    await later();
    expect(created[2].sent[0].setup.sessionResumption).toEqual({});
    /* A second call of the same adapter tries the key that gave out last. */
    const second = await adapter.connect({ instructions: 'i' });
    expect(created.at(-1).key).toBe('two');
    line.close(); second.close();
  });
  test('a cut that is not the key\'s fault picks the line up again on the same key with its handle', async () => {
    const { created, websocketFactory } = google();
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i' });
    created[0].emit('message', JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } }));
    created[0].emit('close', 1006, Buffer.from('connection reset'));
    await later();
    expect(created[1].key).toBe('one');
    expect(created[1].sent[0].setup.sessionResumption.handle).toBe('h1');
    expect(created[1].sent).toHaveLength(1);
    line.close();
  });
  test('a handle that is not resumable is not kept', async () => {
    const { created, websocketFactory } = google();
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i' });
    created[0].emit('message', JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: false } }));
    created[0].emit('close', 1006, Buffer.from('connection reset'));
    await later();
    expect(created[1].key).toBe('two');
    line.close();
  });
  test('only a key or quota refusal makes a key rest: a session that never answers does not', async () => {
    const { created, websocketFactory } = google((ws, count) => (count === 1 ? [1008, Buffer.from('API key not valid')] : count === 2 ? 'silent' : 'open'));
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock, openTimeoutMs: 5 });
    const line = await adapter.connect({ instructions: 'i' });
    expect(created.map(socket => socket.key)).toEqual(['one', 'two', 'one']);
    line.close();
    const next = await adapter.connect({ instructions: 'i' });
    /* 'one' gave out (rests, tried last); 'two' only timed out (awake, tried first). */
    expect(created[3].key).toBe('two');
    next.close();
  });
  test('once a line opens, what failed before may be tried again at the next change', async () => {
    const { created, websocketFactory } = google((ws, count) => (count === 1 ? [4000, Buffer.from('busy')] : 'open'));
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates: [{ model: 'm', key: 'a' }, { model: 'm', key: 'b' }], clock });
    const line = await adapter.connect({ instructions: 'i' });
    expect(created.map(socket => socket.key)).toEqual(['a', 'b']);
    created[1].emit('close', 1011, Buffer.from('quota exhausted'));
    await later();
    expect(created.map(socket => socket.key)).toEqual(['a', 'b', 'a']);
    line.close();
  });
  test('every candidate failing ends the call once', async () => {
    const { created, websocketFactory } = google(() => [1008, Buffer.from('permission denied')]);
    const closed = [];
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    await adapter.connect({ instructions: 'i', onClose: reason => closed.push(reason) });
    expect(created).toHaveLength(4);
    expect(closed).toEqual(['PROVIDER_UNAVAILABLE']);
  });
  test('a conversation the call goes on with is told at the first line, and the assistant speaks first', async () => {
    const { created, websocketFactory } = google();
    const earlier = [{ who: 'person', text: 'Parle-moi de la prière.' }];
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i', earlier });
    expect(created[0].sent[1].clientContent).toEqual({ turns: [{ role: 'user', parts: [{ text: 'person: Parle-moi de la prière.' }] }], turnComplete: true });
    line.close();
    const fresh = await adapter.connect({ instructions: 'i' });
    expect(created.at(-1).sent).toHaveLength(1);
    fresh.close();
  });
  test('the host words what a new session is told, and may tell nothing', async () => {
    const { created, websocketFactory } = google();
    const seen = [];
    const handover = ({ kind, turns }) => { seen.push([kind, turns.length]); return kind === 'resume' ? { text: `RESUME ${turns.length}`, turnComplete: true } : { text: '' }; };
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock, handover });
    const line = await adapter.connect({ instructions: 'i', earlier: [{ who: 'person', text: 'a' }], getHistory: () => [{ who: 'person', text: 'a' }, { who: 'assistant', text: 'b' }] });
    created[0].emit('close', 1008);
    await later();
    expect(seen).toEqual([['resume', 1], ['switch', 2]]);
    expect(created[0].sent[1].clientContent.turns[0].parts[0].text).toBe('RESUME 1');
    expect(created[1].sent).toHaveLength(1);
    line.close();
  });
  test('the tools Google asks for at once run at once, and each answers its own session', async () => {
    const { created, websocketFactory } = google();
    const started = [];
    const release = {};
    const tools = { declarations: [], call: ({ id }) => new Promise(resolve => { started.push(id); release[id] = resolve; }) };
    const events = [];
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i', tools, onEvent: event => events.push(event.type + (event.name ? `:${event.name}` : '')) });
    created[0].emit('message', JSON.stringify({ toolCall: { functionCalls: [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }] } }));
    expect(started).toEqual(['a', 'b']);
    created[0].emit('message', JSON.stringify({ toolCallCancellation: { ids: ['a'] } }));
    release.b({ ok: 'b' });
    release.a({ ok: 'a' });
    await later();
    expect(created[0].sent.filter(message => message.toolResponse).map(message => message.toolResponse.functionResponses[0].id)).toEqual(['b']);
    expect(events).toEqual(['ready', 'tool:one', 'tool:two', 'tool_done:two', 'tool_done:one']);
    /* A session that took over never asked: its answer goes nowhere. */
    created[0].emit('message', JSON.stringify({ toolCall: { functionCalls: [{ id: 'c', name: 'three' }] } }));
    created[0].emit('close', 1008);
    await later();
    release.c({ ok: 'c' });
    await later();
    expect(created[1].sent.some(message => message.toolResponse)).toBe(false);
    line.close();
  });
  test('a tool that throws is answered as the host words it', async () => {
    const { created, websocketFactory } = google();
    const tools = { declarations: [], call: async () => { throw new Error('boom'); } };
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock, toolError: error => ({ error: error.message }) });
    const line = await adapter.connect({ instructions: 'i', tools });
    created[0].emit('message', JSON.stringify({ toolCall: { functionCalls: [{ id: 'a', name: 'one' }] } }));
    await later();
    expect(created[0].sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: 'a', name: 'one', response: { error: 'boom' } }] } });
    line.close();
  });
  test('an image is bounded in characters, and one shown while no session is open is not counted', async () => {
    const { created, websocketFactory } = google();
    let time = 0;
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock: { now: () => time, setTimeout, clearTimeout }, maxImageChars: 10 });
    const line = await adapter.connect({ instructions: 'i' });
    expect(line.sendImage('x'.repeat(11))).toBe(false);
    expect(line.sendImage('x'.repeat(10))).toBe(true);
    created[0].emit('close', 1008);
    expect(line.sendImage('y')).toBe(false);
    await later();
    expect(line.sendImage('y')).toBe(false);
    time = 1000;
    expect(line.sendImage('y')).toBe(true);
    line.close();
  });
  test('the audio the person sends while a new session opens is kept and sent first', async () => {
    const { created, websocketFactory } = google();
    const adapter = createGeminiLiveAdapter({ websocketFactory, candidates, clock });
    const line = await adapter.connect({ instructions: 'i', getHistory: () => [{ who: 'person', text: 'a' }] });
    created[0].emit('close', 1008);
    line.sendAudio('HELD');
    await later();
    expect(created[1].sent.map(message => Object.keys(message)[0])).toEqual(['setup', 'clientContent', 'realtimeInput']);
    expect(created[1].sent[2].realtimeInput.audio.data).toBe('HELD');
    line.close();
  });
});
test('one message of Google gives its events in the order they are heard: the voice, what is written of it, then its end', () => {
  const types = geminiEvents({
    serverContent: {
      turnComplete: true,
      interrupted: true,
      outputTranscription: { text: 'said' },
      inputTranscription: { text: 'heard' },
      modelTurn: { parts: [{ inlineData: { data: 'AA==' } }, { text: 'text' }] }
    }
  }).map(event => event.type);
  expect(types).toEqual(['audio', 'text', 'heard', 'said', 'interrupted', 'turn']);
});
