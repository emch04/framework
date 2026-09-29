const http = require('node:http');
const { openEventStream } = require('../src');

/* Un serveur à un seul flux ; `onOpen` le reçoit une fois ouvert. */
async function serve(onOpen) {
  const server = http.createServer((req, res) => onOpen(openEventStream(res), res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

describe('openEventStream', () => {
  test('each event goes out as it comes, typed, its data in JSON; no proxy holds it back', async () => {
    const { server, url } = await serve((events) => {
      events.send('step', { id: 's1', tool: 'read_bible' });
      events.send('answer', { text: 'Ligne 1\nLigne 2' });
      events.close();
    });
    try {
      const response = await globalThis.fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      expect(await response.text()).toBe('event: step\ndata: {"id":"s1","tool":"read_bible"}\n\nevent: answer\ndata: {"text":"Ligne 1\\nLigne 2"}\n\n');
    } finally {
      server.close();
    }
  });

  test('when the person leaves, the work is told to stop and nothing more is written', async () => {
    let opened;
    const { server, url } = await serve((events, res) => {
      opened = { events, res };
      events.send('step', { id: 's1' });
    });
    try {
      const controller = new globalThis.AbortController();
      const response = await globalThis.fetch(url, { signal: controller.signal });
      await response.body.getReader().read();
      expect(opened.events.signal.aborted).toBe(false);
      controller.abort();
      await new Promise((resolve) => opened.res.once('close', resolve));
      expect(opened.events.signal.aborted).toBe(true);
      expect(() => opened.events.send('answer', { text: 'trop tard' })).not.toThrow();
      expect(() => opened.events.close()).not.toThrow();
    } finally {
      server.close();
    }
  });

  test('a stream closed by the server is not a person leaving', async () => {
    let opened;
    const { server, url } = await serve((events) => {
      opened = events;
      events.close();
    });
    try {
      await (await globalThis.fetch(url)).text();
      expect(opened.signal.aborted).toBe(false);
    } finally {
      server.close();
    }
  });

  test('not a response: refused up front', () => {
    expect(() => openEventStream({})).toThrow(/ServerResponse/);
  });
});
