const {
  EventEmitter
} = require('events');
const {
  createLiveSession,
  attachLive,
  CLOSE
} = require('../src');
function setup(extra = {}) {
  let time = 0;
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = raw => sent.push(JSON.parse(raw));
  socket.close = jest.fn();
  const clock = {
    now: () => time,
    setInterval: jest.fn(() => 1),
    clearInterval: jest.fn(),
    setTimeout,
    clearTimeout
  };
  const line = {
    sendAudio: jest.fn(),
    sendText: jest.fn(),
    close: jest.fn(),
    mute: jest.fn(),
    interrupt: jest.fn()
  };
  const provider = {
    connect: jest.fn(async ({
      onEvent
    }) => {
      provider.event = onEvent;
      return line;
    })
  };
  const session = createLiveSession({
    socket,
    context: {
      userId: 'u',
      role: 'member',
      language: 'en'
    },
    provider,
    clock,
    ...extra
  });
  return {
    session,
    socket,
    sent,
    clock,
    line,
    provider,
    advance: ms => {
      time += ms;
    }
  };
}
test('starts provider session', async () => {
  const s = setup();
  await s.session.start();
  expect(s.provider.connect).toHaveBeenCalledTimes(1);
  await s.session.close();
});
test('sends audio and text to provider', async () => {
  const s = setup();
  await s.session.start();
  await s.session.receive(JSON.stringify({
    type: 'audio',
    data: 'AA=='
  }));
  await s.session.receive(JSON.stringify({
    type: 'text',
    text: 'hello'
  }));
  expect(s.line.sendAudio).toHaveBeenCalledWith('AA==');
  expect(s.line.sendText).toHaveBeenCalledWith('hello');
  await s.session.close();
});
test('mute suppresses audio', async () => {
  const s = setup();
  await s.session.start();
  await s.session.receive('{"type":"mute"}');
  await s.session.receive('{"type":"audio","data":"AA=="}');
  expect(s.line.sendAudio).not.toHaveBeenCalled();
  await s.session.close();
});
test('provider transcription becomes a turn', async () => {
  const s = setup();
  await s.session.start();
  s.provider.event({
    type: 'heard',
    text: 'hello'
  });
  expect(s.session.turns).toEqual([{
    who: 'person',
    text: 'hello'
  }]);
  await s.session.close();
});
test('provider audio goes to client', async () => {
  const s = setup();
  await s.session.start();
  s.provider.event({
    type: 'audio',
    data: 'AA=='
  });
  expect(s.sent.some(m => m.type === 'audio')).toBe(true);
  await s.session.close();
});
test('idle closes call', async () => {
  const s = setup();
  await s.session.start();
  s.advance(60000);
  await s.session.tick();
  expect(s.session.ended).toBe(true);
  expect(s.sent.at(-1).reason).toBe('IDLE');
});
test('max call duration closes call', async () => {
  const s = setup({
    idleMs: 5000000
  });
  await s.session.start();
  s.advance(1800000);
  await s.session.tick();
  expect(s.sent.at(-1).reason).toBe('CALL_LIMIT');
});
test('quota warning is sent once', async () => {
  const s = setup({
    quota: {
      check: async () => ({
        code: 'QUOTA_WARNING',
        remainingMs: 1000
      }),
      charge: async () => {}
    }
  });
  await s.session.start();
  await s.session.tick();
  await s.session.tick();
  expect(s.sent.filter(m => m.type === 'quota')).toHaveLength(1);
  await s.session.close();
});
test('quota exhaustion blocks startup', async () => {
  const s = setup({
    quota: {
      check: async () => ({
        code: 'QUOTA_EXHAUSTED'
      }),
      charge: async () => {}
    }
  });
  await s.session.start();
  expect(s.provider.connect).not.toHaveBeenCalled();
  expect(s.sent.at(-1).reason).toBe('QUOTA_EXHAUSTED');
});
test('quota store failure degrades without dropping the call', async () => {
  const s = setup({ quota: { check: async () => { throw new Error('offline'); } } });
  await s.session.start();
  expect(s.provider.connect).toHaveBeenCalledTimes(1);
  await s.session.close();
});
test('session debits quota as the call runs', async () => {
  const quota = {
    check: async () => ({
      code: 'QUOTA_OK'
    }),
    debit: jest.fn(async (_ctx, ms) => ms),
    charge: jest.fn()
  };
  const s = setup({
    quota
  });
  await s.session.start();
  s.advance(5000);
  await s.session.tick();
  expect(quota.debit).toHaveBeenCalledWith(expect.any(Object), 5000);
  await s.session.close();
});
test('lost cross-process lease ends old call', async () => {
  const lease = {
    acquire: jest.fn(),
    isOwner: async () => false,
    release: jest.fn()
  };
  const s = setup({
    lease
  });
  await s.session.start();
  await s.session.tick();
  expect(s.sent.at(-1).reason).toBe('REPLACED');
  expect(s.socket.close).toHaveBeenCalledWith(4409);
});
test('invalid messages are ignored', async () => {
  const s = setup();
  await s.session.start();
  await s.session.receive('garbage');
  expect(s.line.sendText).not.toHaveBeenCalled();
  await s.session.close();
});
test('end message closes once', async () => {
  const s = setup();
  await s.session.start();
  await s.session.receive('{"type":"end"}');
  await s.session.receive('{"type":"end"}');
  expect(s.socket.close).toHaveBeenCalledTimes(1);
});
test('fresh requested conversation is passed to provider', async () => {
  const store = {
    get: async () => ({
      id: 'c',
      userId: 'u',
      updatedAt: 0,
      turns: [{
        who: 'person',
        text: 'previous'
      }]
    }),
    create: jest.fn(),
    append: jest.fn()
  };
  const s = setup({
    context: {
      userId: 'u',
      role: 'member',
      language: 'en',
      conversationId: 'c'
    },
    transcripts: store
  });
  await s.session.start();
  expect(s.provider.connect.mock.calls[0][0].earlier).toHaveLength(1);
  await s.session.close();
});
test('provider reconnect history includes turns spoken during this call', async () => {
  const s = setup({
    shield: {
      history: text => text.replace('secret', '[MASK]')
    }
  });
  await s.session.start();
  s.provider.event({
    type: 'heard',
    text: 'secret'
  });
  s.provider.event({
    type: 'said',
    text: 'answer'
  });
  const history = s.provider.connect.mock.calls[0][0].getHistory();
  expect(history).toEqual([{
    who: 'person',
    text: '[MASK]'
  }, {
    who: 'assistant',
    text: 'answer'
  }]);
  await s.session.close();
});
test('oversize text and image messages are ignored', async () => {
  const s = setup();
  s.line.sendImage = jest.fn();
  await s.session.start();
  await s.session.receive(JSON.stringify({
    type: 'text',
    text: 'x'.repeat(2001)
  }));
  await s.session.receive(JSON.stringify({
    type: 'image',
    data: 'x'.repeat(256 * 1024)
  }));
  expect(s.line.sendText).not.toHaveBeenCalled();
  expect(s.line.sendImage).not.toHaveBeenCalled();
  await s.session.close();
});
test('injected text model can run the confidential path', async () => {
  const {
    createConfidentialPolicy
  } = require('@astratra/voice');
  const generate = jest.fn(async () => ({
    parts: [{
      text: 'Answer.'
    }]
  }));
  const s = setup({
    context: {
      userId: 'u',
      role: 'locked',
      mode: 'confidential',
      language: 'en'
    },
    policy: createConfidentialPolicy({
      lockedRoles: ['locked']
    }),
    local: {
      transcribe: async () => ({
        text: 'Question'
      }),
      textModel: {
        generate
      },
      reader: {
        synthesize: async () => ({
          audio: Buffer.from([1, 2])
        })
      }
    }
  });
  await s.session.start();
  await s.session.receive('{"type":"text","text":"Question"}');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(s.sent.some(event => event.type === 'said')).toBe(true);
  await s.session.close();
});
test('normal hang-up flushes the last local speech segment', async () => {
  const { createConfidentialPolicy } = require('@astratra/voice');
  const { bytesToBase64, floatToPcm16 } = require('../src');
  const s = setup({
    context: { userId: 'u', role: 'locked', mode: 'confidential', language: 'en' },
    policy: createConfidentialPolicy({ lockedRoles: ['locked'] }),
    local: {
      transcribe: async () => ({ text: 'question' }),
      thinker: async ({ onText }) => onText('answer.'),
      reader: { synthesize: async () => ({ audio: Buffer.from([1, 2]) }) },
      voiceOptions: { frameSize: 4, vad: { startFrames: 1, minSpeechFrames: 1, endFrames: 4, lookbackFrames: 0 } }
    }
  });
  await s.session.start();
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  await s.session.receive(JSON.stringify({ type: 'audio', data: sound }));
  await s.session.close();
  expect(s.session.turns.some((turn) => turn.who === 'person' && turn.text === 'question')).toBe(true);
});
test('locked confidential role does not leak audio without local dependencies', async () => {
  const {
    createConfidentialPolicy
  } = require('@astratra/voice');
  const s = setup({
    context: {
      userId: 'u',
      role: 'locked',
      mode: 'confidential'
    },
    policy: createConfidentialPolicy({
      lockedRoles: ['locked']
    })
  });
  await s.session.start();
  expect(s.provider.connect).not.toHaveBeenCalled();
  expect(s.sent.at(-1).reason).toBe('LOCAL_UNAVAILABLE');
});
test('client confirm invokes pending action without spoken answer', async () => {
  const {
    createToolRegistry
  } = require('@astratra/ai');
  const registry = createToolRegistry();
  registry.register({
    name: 'write',
    description: 'Write',
    type: 'write',
    roles: ['member'],
    handler: async () => null
  });
  const actions = {
    queue: async () => 'a',
    execute: jest.fn(async () => ({
      success: true
    }))
  };
  const s = setup({
    registry,
    actions
  });
  await s.session.start();
  await s.provider.connect.mock.calls[0][0].tools.call({
    name: 'write'
  });
  await s.session.receive('{"type":"confirm","actionId":"a"}');
  expect(actions.execute).toHaveBeenCalledTimes(1);
  await s.session.close();
});
test('tool annotation follows the assistant reply into persisted turns', async () => {
  const { createToolRegistry } = require('@astratra/ai');
  const registry = createToolRegistry();
  registry.register({
    name: 'read', description: 'Read', type: 'read', roles: ['member'],
    handler: async () => ({ ref: 'r' })
  });
  const append = jest.fn();
  const s = setup({
    registry,
    annotateToolResult: (_name, result) => ({ ref: result.ref }),
    transcripts: { create: async () => 'c', append }
  });
  await s.session.start();
  s.provider.event({ type: 'heard', text: 'question' });
  await s.provider.connect.mock.calls[0][0].tools.call({ name: 'read' });
  s.provider.event({ type: 'said', text: 'answer' });
  await s.session.close();
  expect(append.mock.calls[0][2][1].annotations).toEqual([{ ref: 'r' }]);
});
test('mode switches to confidential without closing client', async () => {
  const {
    createConfidentialPolicy
  } = require('@astratra/voice');
  const local = {
    transcribe: async () => 'hello',
    thinker: async () => 'answer.',
    reader: {
      synthesize: async () => ({
        audio: Buffer.from([1, 2])
      })
    }
  };
  const s = setup({
    local,
    policy: createConfidentialPolicy({
      cloudFallbackRoles: ['member']
    })
  });
  await s.session.start();
  await s.session.receive('{"type":"mode","mode":"confidential"}');
  expect(s.session.mode).toBe('confidential');
  expect(s.socket.close).not.toHaveBeenCalled();
  await s.session.close();
});
test('direct audio uses injected voice gate and echo guard', async () => {
  const s = setup({
    directAudio: {
      vad: {
        frameSize: 4,
        lookbackFrames: 0,
        hangFrames: 0
      }
    }
  });
  await s.session.start();
  const {
    bytesToBase64,
    floatToPcm16
  } = require('../src');
  const audio = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  await s.session.receive(JSON.stringify({
    type: 'audio',
    data: audio
  }));
  expect(s.line.sendAudio).toHaveBeenCalled();
  await s.session.close();
});
test('messages received during startup are replayed', async () => {
  let resolve;
  const provider = {
    connect: async () => new Promise(done => {
      resolve = done;
    })
  };
  const s = setup({
    provider
  });
  const starting = s.session.start();
  await Promise.resolve();
  await s.session.receive('{"type":"text","text":"hello"}');
  const line = {
    sendText: jest.fn(),
    close: jest.fn()
  };
  resolve(line);
  await starting;
  expect(line.sendText).toHaveBeenCalledWith('hello');
  await s.session.close();
});
test('server rejects missing auth', async () => {
  const http = new EventEmitter();
  const ws = {
    handleUpgrade: (_req, _sock, _head, cb) => cb({
      close: jest.fn(),
      on: jest.fn()
    })
  };
  const server = attachLive({
    httpServer: http,
    websocketServer: ws,
    authenticate: async () => null,
    createSession: jest.fn()
  });
  http.emit('upgrade', {
    url: '/live'
  }, {}, null);
  await Promise.resolve();
  expect(server.size).toBe(0);
  server.close();
});
test('server ignores other paths', () => {
  const http = new EventEmitter();
  const ws = {
    handleUpgrade: jest.fn()
  };
  const server = attachLive({
    httpServer: http,
    websocketServer: ws,
    authenticate: async () => null,
    createSession: jest.fn()
  });
  http.emit('upgrade', {
    url: '/other'
  }, {}, null);
  expect(ws.handleUpgrade).not.toHaveBeenCalled();
  server.close();
});
test('injected guard rejects a call after authentication', async () => {
  const http = new EventEmitter();
  const client = {
    readyState: 1,
    send: jest.fn(),
    close: jest.fn()
  };
  const createSession = jest.fn();
  const server = attachLive({
    httpServer: http,
    websocketServer: {
      handleUpgrade: (_request, _socket, _head, callback) => callback(client)
    },
    authenticate: async () => ({
      userId: 'u'
    }),
    authorize: async () => ({
      allowed: false,
      reason: 'ORIGIN'
    }),
    createSession
  });
  http.emit('upgrade', {
    url: '/live'
  }, {}, null);
  await Promise.resolve();
  await Promise.resolve();
  expect(client.close).toHaveBeenCalledWith(CLOSE.DENIED);
  expect(JSON.parse(client.send.mock.calls[0][0]).reason).toBe('ORIGIN');
  expect(createSession).not.toHaveBeenCalled();
  server.close();
});
test('new call replaces its prior line and capacity rejects another user', async () => {
  const http = new EventEmitter();
  const clients = [];
  const sessions = [];
  let userId = 'u';
  const server = attachLive({
    httpServer: http,
    websocketServer: {
      handleUpgrade: (_request, _socket, _head, callback) => {
        const client = new EventEmitter();
        client.readyState = 1;
        client.send = jest.fn();
        client.close = jest.fn();
        clients.push(client);
        callback(client);
      }
    },
    authenticate: async () => ({ userId }),
    maxCalls: 1,
    createSession: () => {
      const session = { start: async () => {}, receive: async () => {}, close: jest.fn(async () => {}) };
      sessions.push(session);
      return session;
    }
  });
  http.emit('upgrade', { url: '/live' }, {}, null);
  await new Promise((resolve) => setImmediate(resolve));
  http.emit('upgrade', { url: '/live' }, {}, null);
  await new Promise((resolve) => setImmediate(resolve));
  expect(sessions[0].close).toHaveBeenCalledWith('REPLACED', CLOSE.REPLACED);
  userId = 'other';
  http.emit('upgrade', { url: '/live' }, {}, null);
  await new Promise((resolve) => setImmediate(resolve));
  expect(JSON.parse(clients[2].send.mock.calls[0][0])).toEqual({ type: 'error', reason: 'BUSY' });
  expect(clients[2].close).toHaveBeenCalledWith(CLOSE.BUSY);
  expect(server.size).toBe(1);
  server.close();
});
test('close codes are stable', () => {
  expect(CLOSE).toEqual({
    AUTH: 4401,
    DENIED: 4403,
    REPLACED: 4409,
    BUSY: 4429,
    UNAVAILABLE: 4503,
    NORMAL: 1000
  });
});
