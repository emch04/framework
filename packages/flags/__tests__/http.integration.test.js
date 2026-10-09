const http = require('node:http');
const { once } = require('node:events');
const { createUrlSource, createFlagProvider } = require('../src');

test('real HTTP configuration refresh retains last valid rules on failure and timeout', async () => {
  let mode = 'valid';
  let enabled = true;
  const server = http.createServer((_req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'cut') return res.destroy();
    if (mode === 'error') { res.writeHead(503); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'invalid' ? '{' : JSON.stringify({ flags: { feature: { type: 'boolean', default: false, value: enabled } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const source = createUrlSource(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 100 });
  const provider = createFlagProvider({ source });
  try {
    expect((await provider.resolveBoolean('feature')).value).toBe(true);
    enabled = false; await source.refresh();
    expect((await provider.resolveBoolean('feature')).value).toBe(false);
    for (mode of ['error', 'invalid', 'cut', 'timeout']) {
      await source.refresh();
      expect((await provider.resolveBoolean('feature', true)).value).toBe(false);
    }
    const empty = createUrlSource(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 50 });
    expect(await createFlagProvider({ source: empty }).resolveBoolean('feature', true)).toMatchObject({ value: true, reason: 'ERROR' });
    mode = 'valid'; enabled = true; await source.refresh();
    expect((await provider.resolveBoolean('feature')).value).toBe(true);
  } finally { await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
