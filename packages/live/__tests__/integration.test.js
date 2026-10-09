const http = require('node:http');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { attachLive, createLiveSession, CLOSE } = require('../src');

// Both sides use real network sockets. Only the provider's application logic is simulated.
async function fixture(mode = 'normal') {
  const providerHttp = http.createServer();
  const providerWs = new WebSocketServer({ server: providerHttp });
  const received = [];
  providerWs.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      received.push(message);
      if (mode === 'cut') return socket.close(1011);
      if (message.type === 'text') {
        socket.send(JSON.stringify({ type: 'said', text: `Reply: ${message.text}` }));
        socket.send(JSON.stringify({ type: 'audio', data: Buffer.from([1, 2]).toString('base64') }));
        socket.send(JSON.stringify({ type: 'turn' }));
      }
    });
  });
  providerHttp.listen(0, '127.0.0.1'); await once(providerHttp, 'listening');
  let providerSocket;
  const provider = {
    async connect({ onEvent, onClose }) {
      providerSocket = new WebSocket(`ws://127.0.0.1:${providerHttp.address().port}`);
      providerSocket.on('message', raw => onEvent(JSON.parse(raw)));
      providerSocket.on('close', () => onClose('PROVIDER_CLOSED'));
      await once(providerSocket, 'open');
      return {
        sendText: text => providerSocket.send(JSON.stringify({ type: 'text', text })),
        sendAudio: data => providerSocket.send(JSON.stringify({ type: 'audio', data })),
        close: () => providerSocket.close()
      };
    }
  };
  const server = http.createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  const ends = [];
  const clock = { now: Date.now, setInterval, clearInterval, setTimeout, clearTimeout };
  const live = attachLive({ httpServer: server, websocketServer,
    authenticate: async () => ({ userId: 'user', role: 'member', language: 'en', mode: 'normal' }),
    createSession: options => createLiveSession({ ...options, provider, clock,
      idleMs: mode === 'timeout' ? 80 : 5000, checkMs: 10, onEnd: end => ends.push(end) }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/live`);
  const messages = [];
  client.on('message', raw => messages.push(JSON.parse(raw)));
  const closed = once(client, 'close');
  await once(client, 'open');
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Integration event deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { client, messages, received, ends, closed, live, waitFor,
    async cleanup() {
      client.terminate(); live.close();
      providerSocket?.terminate();
      for (const socket of providerWs.clients) socket.terminate();
      await new Promise(resolve => providerWs.close(resolve));
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => providerHttp.close(resolve))]);
    }
  };
}

test('real HTTP/WebSocket call exchanges text and audio and ends cleanly', async () => {
  const f = await fixture();
  try {
    await f.waitFor(() => f.messages.some(m => m.type === 'ready'));
    const audio = Buffer.from([3, 4]).toString('base64');
    f.client.send(JSON.stringify({ type: 'audio', data: audio }));
    f.client.send(JSON.stringify({ type: 'text', text: 'Hello' }));
    await f.waitFor(() => f.messages.some(m => m.type === 'turn'));
    expect(f.received).toEqual([{ type: 'audio', data: audio }, { type: 'text', text: 'Hello' }]);
    expect(f.messages).toEqual(expect.arrayContaining([{ type: 'said', text: 'Reply: Hello' }, { type: 'audio', data: Buffer.from([1, 2]).toString('base64') }]));
    f.client.send(JSON.stringify({ type: 'end' }));
    expect((await f.closed)[0]).toBe(CLOSE.NORMAL);
    await f.waitFor(() => f.ends.length === 1 && f.live.size === 0);
    expect(f.ends[0].reason).toBe('NORMAL');
    expect(f.ends[0].turns.map(t => t.text)).toEqual(['Hello', 'Reply: Hello']);
  } finally { await f.cleanup(); }
});

test('real provider disconnect closes the call with unavailable status', async () => {
  const f = await fixture('cut');
  try {
    await f.waitFor(() => f.messages.some(m => m.type === 'ready'));
    f.client.send(JSON.stringify({ type: 'text', text: 'Hello' }));
    expect((await f.closed)[0]).toBe(CLOSE.UNAVAILABLE);
    expect(f.messages).toContainEqual({ type: 'end', reason: 'PROVIDER_CLOSED' });
    await f.waitFor(() => f.live.size === 0);
  } finally { await f.cleanup(); }
});

test('real silent call exceeds its idle deadline and releases the session', async () => {
  const f = await fixture('timeout');
  try {
    expect((await f.closed)[0]).toBe(CLOSE.NORMAL);
    expect(f.messages).toContainEqual({ type: 'idle' });
    expect(f.messages).toContainEqual({ type: 'end', reason: 'IDLE' });
    await f.waitFor(() => f.ends.length === 1 && f.live.size === 0);
  } finally { await f.cleanup(); }
});
