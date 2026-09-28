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
