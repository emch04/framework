const { EventEmitter } = require('events');
const { createConfidentialPolicy } = require('@astratra/voice');
const { createLiveSession, attachLive, CLOSE } = require('../src');

/* A phone, a clock and a provider whose line the test plays. */
function setup(extra = {}) {
  let time = 0;
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (raw) => sent.push(JSON.parse(raw));
  socket.close = jest.fn();
  const clock = { now: () => time, setInterval: jest.fn(() => 1), clearInterval: jest.fn(), setTimeout, clearTimeout };
  const line = { sendAudio: jest.fn(), sendText: jest.fn(), close: jest.fn(), mute: jest.fn(), interrupt: jest.fn(), sendImage: jest.fn(() => true) };
  const provider = { connect: jest.fn(async ({ onEvent }) => { provider.event = onEvent; return line; }) };
  const session = createLiveSession({ socket, context: { userId: 'u', role: 'person', language: 'fr', allowCloudFallback: true }, provider, clock, ...extra });
  return { session, socket, sent, clock, line, provider, advance: (ms) => { time += ms; } };
}
const pcm = (samples) => Buffer.from(Int16Array.from(samples).buffer).toString('base64');
const policy = createConfidentialPolicy({ cloudFallbackRoles: ['person'] });
const types = (sent) => sent.map((message) => message.type);

describe('the wire a host speaks', () => {
  test('its own encoding replaces the default one: a message may be renamed, reshaped or left unsent', async () => {
    const wire = { encode: (message) => (message.type === 'end' ? null : message.type === 'fallback' ? JSON.stringify({ type: 'directFallback' }) : JSON.stringify(message)) };
    const s = setup({ wire });
    await s.session.start();
    s.provider.event({ type: 'ready', model: 'm' });
    s.provider.event({ type: 'directFallback-never-in-the-default-list' });
    await s.session.close();
    expect(types(s.sent)).toEqual(['ready', 'directFallback-never-in-the-default-list']);
    expect(s.socket.close).toHaveBeenCalledWith(1000);
  });
  test('its own decoding reads what its clients send', async () => {
    const s = setup({ wire: { decode: (raw) => ({ type: 'text', text: String(raw).toUpperCase() }) } });
    await s.session.start();
    await s.session.receive('bonjour');
    expect(s.line.sendText).toHaveBeenCalledWith('BONJOUR');
    await s.session.close();
  });
  test('every message is shown to the host before it goes, and the host failing changes nothing', async () => {
    const seen = [];
    const s = setup({ observe: (message) => { seen.push(message.type); throw new Error('the host is broken'); } });
    await s.session.start();
    s.provider.event({ type: 'ready', model: 'm' });
    await s.session.close('NORMAL');
    expect(seen).toEqual(['ready', 'end']);
    expect(types(s.sent)).toEqual(['ready', 'end']);
  });
  test('a call that ends tells the host how, after the phone is let go', async () => {
    const ended = [];
    const s = setup({ onEnd: (info) => ended.push(info) });
    await s.session.start();
    s.provider.event({ type: 'heard', text: 'salut' });
    s.advance(12345);
    await s.session.close('IDLE', 1000);
    await Promise.resolve();
    expect(ended).toEqual([{ reason: 'IDLE', code: 1000, startedAt: 0, endedAt: 12345, turns: [{ who: 'person', text: 'salut' }], conversationId: null }]);
    const failing = setup({ onEnd: () => { throw new Error('logs are down'); } });
    await failing.session.start();
    await expect(failing.session.close()).resolves.toBeUndefined();
  });
});

describe('a host with its own tools and its own prompt', () => {
  test('its tools are used as they are, answer the provider, and what they annotate follows the reply into the transcript', async () => {
    const append = jest.fn();
    const call = jest.fn(async ({ name }) => ({ from: name }));
    const s = setup({
      tools: { declarations: [{ name: 'read_bible' }], call },
      annotateToolResult: (name, result) => ({ name, result }),
      transcripts: { create: async () => 'c1', append }
    });
    await s.session.start();
    const given = s.provider.connect.mock.calls[0][0].tools;
    expect(given.declarations).toEqual([{ name: 'read_bible' }]);
    s.provider.event({ type: 'heard', text: 'Lis Jean 3:16' });
    expect(await given.call({ id: 'x', name: 'read_bible', args: {} })).toEqual({ from: 'read_bible' });
    s.provider.event({ type: 'said', text: 'Voici.' });
    await s.session.close();
    expect(append.mock.calls[0][2][1].annotations).toEqual([{ name: 'read_bible', result: { from: 'read_bible' } }]);
  });
  test('they may be made when the call starts, and a client\'s confirm is ignored where the host has no such thing', async () => {
    const made = jest.fn(async (context) => ({ declarations: [], call: async () => context.userId }));
    const s = setup({ tools: made });
    await s.session.start();
    expect(made).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u' }));
    await s.session.receive('{"type":"confirm","actionId":"a"}');
    expect(s.sent.some((message) => message.type === 'error')).toBe(false);
    await s.session.close();
  });
  test('the instructions are the host\'s own, given as text or made from the call and its mode, and the shield masks them', async () => {
    const built = setup({ instructions: 'You are Tertius, Marie.', shield: { input: (text) => text.replace('Marie', '[M]') } });
    await built.session.start();
    expect(built.provider.connect.mock.calls[0][0].instructions).toBe('You are Tertius, [M].');
    await built.session.close();
    const made = jest.fn(async ({ context, mode }) => `${context.userId} in ${mode}`);
    const s = setup({ instructions: made });
    await s.session.start();
    expect(made).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ userId: 'u' }), mode: 'normal' }));
    expect(s.provider.connect.mock.calls[0][0].instructions).toBe('u in normal');
    await s.session.close();
  });
  test('the conversation is created with the words it begins with, for the host to title it', async () => {
    const create = jest.fn(async () => 'c1');
    const s = setup({ transcripts: { create, append: jest.fn() } });
    await s.session.start();
    s.provider.event({ type: 'said', text: 'Bonjour !' });
    s.provider.event({ type: 'heard', text: 'Pourquoi prier ?' });
    s.provider.event({ type: 'turn' });
    await s.session.close();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', first: { role: 'user', text: 'Pourquoi prier ?' } }));
    expect(s.sent.find((message) => message.type === 'saved')).toEqual({ type: 'saved', conversationId: 'c1' });
  });
  test('what was said in the resumed conversation is known to the host', async () => {
    const s = setup({ context: { userId: 'u', role: 'person', language: 'fr', conversationId: 'c' }, transcripts: { get: async () => ({ id: 'c', userId: 'u', updatedAt: 0, turns: [{ who: 'person', text: 'avant' }] }) } });
    await s.session.start();
    expect(s.session.history).toEqual([{ who: 'person', text: 'avant' }]);
    expect(s.sent[0]).toEqual({ type: 'saved', conversationId: 'c' });
    await s.session.close();
  });
});

describe('a call is alive while the person or the assistant does something, not while the microphone runs', () => {
  test('the microphone\'s sound does not keep a call open, words do, a tool at work does, a photo does', async () => {
    const s = setup();
    await s.session.start();
    s.advance(50000);
    await s.session.receive(JSON.stringify({ type: 'audio', data: pcm([1, 2, 3]) }));
    await s.session.receive('{"type":"mute"}');
    await s.session.receive('{"type":"unmute"}');
    s.advance(10000);
    await s.session.tick();
    expect(s.session.ended).toBe(true);
    expect(s.sent.at(-1)).toEqual({ type: 'end', reason: 'IDLE' });

    const alive = setup();
    await alive.session.start();
    alive.advance(50000);
    alive.provider.event({ type: 'heard', text: 'Bonjour' });
    alive.advance(50000);
    await alive.session.tick();
    expect(alive.session.ended).toBe(false);
    alive.provider.event({ type: 'tool', name: 'read' });
    alive.advance(500000);
    await alive.session.tick();
    expect(alive.session.ended).toBe(false);
    alive.provider.event({ type: 'tool_done', name: 'read' });
    alive.advance(59000);
    await alive.session.tick();
    expect(alive.session.ended).toBe(false);
    await alive.session.receive(JSON.stringify({ type: 'image', data: '/9j/AAAA' }));
    expect(alive.line.sendImage).toHaveBeenCalled();
    alive.advance(59000);
    await alive.session.tick();
    expect(alive.session.ended).toBe(false);
    alive.advance(2000);
    await alive.session.tick();
    expect(alive.session.ended).toBe(true);
  });
  test('a photo the provider did not take does not count', async () => {
    const s = setup();
    s.line.sendImage = jest.fn(() => false);
    await s.session.start();
    s.advance(59000);
    await s.session.receive(JSON.stringify({ type: 'image', data: '/9j/AAAA' }));
    s.advance(2000);
    await s.session.tick();
    expect(s.session.ended).toBe(true);
  });
});

describe('what the microphone hears, before it reaches the provider', () => {
  test('a gate made by the host is used as it is, in order, and hears the assistant\'s voice and its interruption', async () => {
    const heard = [];
    const gate = { push: async (data) => { heard.push(data); return data === 'NOISE' ? '' : `F${data}`; }, playbackSent: (...args) => heard.push(args), playbackInterrupted: () => heard.push('stop') };
    const s = setup({ microphone: gate });
    await s.session.start();
    for (const data of ['AAAA', 'NOISE', 'BBBB']) await s.session.receive(JSON.stringify({ type: 'audio', data }));
    expect(s.line.sendAudio.mock.calls).toEqual([['FAAAA'], ['FBBBB']]);
    s.provider.event({ type: 'audio', data: Buffer.alloc(4800).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
    s.provider.event({ type: 'audio', data: Buffer.alloc(3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' });
    s.provider.event({ type: 'audio', data: Buffer.alloc(200).toString('base64') });
    s.provider.event({ type: 'interrupted' });
    expect(heard.slice(3)).toEqual([[4800, 24000], [3200, 16000], [200, 24000], 'stop']);
    await s.session.close();
  });
  test('the gates are made from options, when the call starts, and a host that cannot make them loses nothing', async () => {
    const options = jest.fn(async () => ({ vad: { frameSize: 4, lookbackFrames: 0, hangFrames: 0, classify: (frame) => (frame[0] > 0.1 ? 1 : 0) } }));
    const s = setup({ microphone: options });
    await s.session.start();
    await s.session.receive(JSON.stringify({ type: 'audio', data: pcm([0, 0, 0, 0]) }));
    await s.session.receive(JSON.stringify({ type: 'audio', data: pcm([20000, 20000, 20000, 20000]) }));
    expect(s.line.sendAudio.mock.calls.map(([data]) => Array.from(new Int16Array(new Uint8Array(Buffer.from(data, 'base64')).buffer)))).toEqual([[0, 0, 0, 0], [20000, 20000, 20000, 20000]]);
    await s.session.close();
    const broken = setup({ microphone: async () => { throw new Error('the model would not load'); } });
    await broken.session.start();
    await broken.session.receive(JSON.stringify({ type: 'audio', data: 'AAAA' }));
    expect(broken.line.sendAudio).toHaveBeenCalledWith('AAAA');
    await broken.session.close();
  });
  test('a gate that throws lets the sound through as it came', async () => {
    const s = setup({ microphone: { push: async () => { throw new Error('gate down'); } } });
    await s.session.start();
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'AAAA' }));
    expect(s.line.sendAudio).toHaveBeenCalledWith('AAAA');
    await s.session.close();
  });
  test('the client\'s interrupt goes to the provider unless the host lets the provider hear for itself', async () => {
    const s = setup();
    await s.session.start();
    await s.session.receive('{"type":"interrupt"}');
    expect(s.line.interrupt).toHaveBeenCalledTimes(1);
    await s.session.close();
    const own = setup({ directInterrupt: false });
    await own.session.start();
    await own.session.receive('{"type":"interrupt"}');
    expect(own.line.interrupt).not.toHaveBeenCalled();
    await own.session.close();
  });
});

describe('the confidential path where the provider still speaks', () => {
  function relayed({ items = [], finish = [], push, ...extra } = {}) {
    const queue = [...items];
    const transcriber = { push: push || jest.fn(async () => queue.shift() || []), finish: jest.fn(async () => finish) };
    const s = setup({ context: { userId: 'u', role: 'person', language: 'fr', mode: 'confidential', allowCloudFallback: true }, policy, local: { transcriber }, ...extra });
    return { ...s, transcriber };
  }

  test('the sound never reaches the provider: the sentences do, as text', async () => {
    const s = relayed({ items: [[{ text: 'Bonjour Tertius', confidence: 0.9, audio: 'SEG' }]] });
    await s.session.start();
    expect(s.session.mode).toBe('confidential');
    expect(s.provider.connect).toHaveBeenCalledTimes(1);
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'PCM' }));
    expect(s.transcriber.push).toHaveBeenCalledWith('PCM');
    expect(s.line.sendText).toHaveBeenCalledWith('Bonjour Tertius');
    expect(s.line.sendAudio).not.toHaveBeenCalled();
    expect(s.sent.find((message) => message.type === 'heard')).toEqual({ type: 'heard', text: 'Bonjour Tertius' });
    expect(s.session.turns).toEqual([{ who: 'person', text: 'Bonjour Tertius' }]);
    await s.session.close();
  });
  test('the filters come first, and a muted microphone sends nothing', async () => {
    const gate = { push: async (data) => (data === 'NOISE' ? '' : `F${data}`), playbackSent() {}, playbackInterrupted() {} };
    const s = relayed({ microphone: gate });
    await s.session.start();
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'NOISE' }));
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'A' }));
    await s.session.receive('{"type":"mute"}');
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'B' }));
    expect(s.transcriber.push.mock.calls).toEqual([['FA']]);
    expect(s.line.mute).toHaveBeenCalled();
    await s.session.close();
  });
  test('a doubtful sentence is never sent, twice in a row it moves the call to normal, the sentence replayed once and the sound going on', async () => {
    const s = relayed({ items: [[{ text: 'a', confidence: 0.1, audio: 'S1' }], [{ text: 'b', confidence: 0.1, audio: 'S2' }]] });
    await s.session.start();
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'ONE' }));
    expect(types(s.sent)).toContain('repeat');
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'TWO' }));
    expect(s.sent.at(-1)).toEqual({ type: 'fallback', reason: 'CONFIDENCE_FALLBACK' });
    expect(s.session.mode).toBe('normal');
    expect(s.line.sendText).not.toHaveBeenCalled();
    expect(s.line.sendAudio.mock.calls).toEqual([['S2']]);
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'THREE' }));
    expect(s.line.sendAudio.mock.calls).toEqual([['S2'], ['THREE']]);
    expect(s.provider.connect).toHaveBeenCalledTimes(1);
    await s.session.close();
  });
  test('a decoder that fails moves the call to normal with the sentence, without ending it', async () => {
    const s = relayed({ push: async () => { throw Object.assign(new Error('model failed'), { audio: 'WHOLE' }); } });
    await s.session.start();
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'SPEECH' }));
    expect(s.sent.at(-1)).toEqual({ type: 'fallback', reason: 'LOCAL_FAILURE_FALLBACK' });
    expect(s.line.sendAudio.mock.calls).toEqual([['WHOLE']]);
    expect(s.session.ended).toBe(false);
    await s.session.close();
  });
  test('the phone\'s interrupt tells the guard and the phone, and sends nothing to the provider; after the move to normal it is ignored', async () => {
    const gate = { push: async (data) => data, playbackSent() {}, playbackInterrupted: jest.fn() };
    const s = relayed({ microphone: gate, directInterrupt: false });
    await s.session.start();
    await s.session.receive('{"type":"interrupt"}');
    expect(gate.playbackInterrupted).toHaveBeenCalledTimes(1);
    expect(s.sent.at(-1)).toEqual({ type: 'interrupted' });
    expect(s.line.interrupt).not.toHaveBeenCalled();
    await s.session.receive('{"type":"mode","mode":"normal"}');
    await s.session.receive('{"type":"interrupt"}');
    expect(s.sent.filter((message) => message.type === 'interrupted')).toHaveLength(1);
    await s.session.close();
  });
  test('typed text and photos still reach the provider', async () => {
    const s = relayed();
    await s.session.start();
    await s.session.receive('{"type":"text","text":"Salut"}');
    await s.session.receive(JSON.stringify({ type: 'image', data: '/9j/AAAA' }));
    expect(s.line.sendText).toHaveBeenCalledWith('Salut');
    expect(s.line.sendImage).toHaveBeenCalledWith('/9j/AAAA');
    await s.session.close();
  });
  test('at hang-up what the person was still saying is written down, and the call ends normally', async () => {
    const s = relayed({ finish: [{ text: 'au revoir', confidence: 0.9 }] });
    await s.session.start();
    await s.session.close('NORMAL');
    expect(s.line.sendText).toHaveBeenCalledWith('au revoir');
    expect(s.session.turns).toEqual([{ who: 'person', text: 'au revoir' }]);
    expect(s.socket.close).toHaveBeenCalledWith(1000);
  });
  test('the local models are made when the call starts, once, and a host that cannot load them goes on as normal, told, with instructions written for normal', async () => {
    const instructions = jest.fn(async ({ mode }) => `mode ${mode}`);
    const s = setup({ context: { userId: 'u', role: 'person', language: 'fr', mode: 'confidential', allowCloudFallback: true }, policy, local: async () => { throw new Error('model download failed'); }, instructions });
    await s.session.start();
    expect(s.session.mode).toBe('normal');
    expect(s.sent[0]).toEqual({ type: 'fallback', reason: 'LOCAL_FAILURE_FALLBACK' });
    expect(s.provider.connect.mock.calls[0][0].instructions).toBe('mode normal');
    await s.session.close();

    const made = jest.fn(async () => ({ transcriber: { push: async () => [], finish: async () => [] } }));
    const normal = setup({ local: made, policy });
    await normal.session.start();
    expect(made).not.toHaveBeenCalled();
    await normal.session.close();
  });
  test('where the cloud is forbidden, a host that cannot load them ends the call before a word reaches the provider', async () => {
    const s = setup({
      context: { userId: 'u', role: 'locked', language: 'fr', mode: 'confidential' },
      policy: createConfidentialPolicy({ lockedRoles: ['locked'] }),
      local: async () => { throw new Error('model download failed'); }
    });
    await s.session.start();
    expect(s.provider.connect).not.toHaveBeenCalled();
    expect(s.sent.at(-1)).toEqual({ type: 'end', reason: 'LOCAL_UNAVAILABLE' });
    expect(s.socket.close).toHaveBeenCalledWith(CLOSE.UNAVAILABLE);
  });
  test('the mode may change in the middle of a call without the provider\'s line being opened again', async () => {
    const s = relayed();
    await s.session.start();
    await s.session.receive('{"type":"mode","mode":"normal"}');
    expect(s.session.mode).toBe('normal');
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'A' }));
    expect(s.line.sendAudio).toHaveBeenCalledWith('A');
    await s.session.receive('{"type":"mode","mode":"confidential"}');
    expect(s.session.mode).toBe('confidential');
    await s.session.receive(JSON.stringify({ type: 'audio', data: 'B' }));
    expect(s.transcriber.push).toHaveBeenCalledWith('B');
    expect(s.provider.connect).toHaveBeenCalledTimes(1);
    expect(s.sent.filter((message) => message.type === 'mode').map((message) => message.mode)).toEqual(['normal', 'confidential']);
    await s.session.close();
  });
  test('the sound sent after the move to normal follows the replayed sentence, never overtaking it', async () => {
    let fail;
    const s = relayed({ push: () => new Promise((_resolve, reject) => { fail = reject; }) });
    await s.session.start();
    const first = s.session.receive(JSON.stringify({ type: 'audio', data: 'ONE' }));
    const second = s.session.receive(JSON.stringify({ type: 'audio', data: 'TWO' }));
    await new Promise((resolve) => setImmediate(resolve));
    fail(Object.assign(new Error('model failed'), { audio: 'S1' }));
    await Promise.all([first, second]);
    expect(s.line.sendAudio.mock.calls).toEqual([['S1'], ['TWO']]);
    await s.session.close();
  });
});

describe('a phone that hangs up before the line is open', () => {
  test('the line that opens after it is closed at once, and nothing else is started', async () => {
    let open;
    const line = { sendAudio: jest.fn(), sendText: jest.fn(), close: jest.fn() };
    const provider = { connect: () => new Promise((resolve) => { open = () => resolve(line); }) };
    const s = setup({ provider });
    const starting = s.session.start();
    await new Promise((resolve) => setImmediate(resolve));
    await s.session.close('NORMAL');
    open();
    await starting;
    expect(line.close).toHaveBeenCalledTimes(1);
    expect(s.clock.setInterval).not.toHaveBeenCalled();
    expect(s.socket.close).toHaveBeenCalledTimes(1);
  });
});

describe('the server a host runs its calls on', () => {
  test('a session that cannot start is closed with the phone, so nothing it opened stays open', async () => {
    const http = new EventEmitter();
    const client = new EventEmitter();
    client.readyState = 1;
    client.send = jest.fn();
    client.close = jest.fn();
    const session = { start: async () => { throw new Error('the database is down'); }, receive: async () => {}, close: jest.fn(async () => {}) };
    const server = attachLive({
      httpServer: http,
      websocketServer: { handleUpgrade: (_request, _socket, _head, callback) => callback(client) },
      authenticate: async () => ({ userId: 'u' }),
      createSession: () => session
    });
    http.emit('upgrade', { url: '/live' }, {}, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.close).toHaveBeenCalledWith('SESSION_START_FAILED', CLOSE.UNAVAILABLE);
    expect(client.close).toHaveBeenCalledWith(CLOSE.UNAVAILABLE);
    expect(server.size).toBe(0);
    server.close();
  });
  test('a server that stops says so with the code of a server going away, not the code of a call that ended', async () => {
    const http = new EventEmitter();
    const closes = [];
    const server = attachLive({
      httpServer: http,
      websocketServer: { handleUpgrade: (_request, _socket, _head, callback) => { const client = new EventEmitter(); client.readyState = 1; client.send = jest.fn(); client.close = jest.fn(); callback(client); } },
      authenticate: async () => ({ userId: 'u' }),
      createSession: () => ({ start: async () => {}, receive: async () => {}, close: async (...args) => { closes.push(args); } })
    });
    http.emit('upgrade', { url: '/live' }, {}, null);
    await new Promise((resolve) => setImmediate(resolve));
    server.close();
    expect(closes).toEqual([['SERVER_CLOSED', 1001]]);
  });
  test('a message of the host\'s own shape is sent when a person is refused for lack of room, and its own wire is used to deny a call', async () => {
    const http = new EventEmitter();
    const clients = [];
    const encode = (message) => JSON.stringify({ kind: message.type, why: message.reason });
    const server = attachLive({
      httpServer: http,
      websocketServer: { handleUpgrade: (_request, _socket, _head, callback) => { const client = new EventEmitter(); client.readyState = 1; client.send = jest.fn(); client.close = jest.fn(); clients.push(client); callback(client); } },
      authenticate: async () => ({ userId: `user-${clients.length}` }),
      authorize: async () => ({ allowed: false, reason: 'ORIGIN' }),
      maxCalls: 1,
      encode,
      createSession: () => ({ start: async () => {}, receive: async () => {}, close: async () => {} })
    });
    http.emit('upgrade', { url: '/live' }, {}, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(clients[0].send.mock.calls[0][0])).toEqual({ kind: 'error', why: 'ORIGIN' });
    server.close();
  });
});
