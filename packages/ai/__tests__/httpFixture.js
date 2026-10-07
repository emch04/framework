const http = require('node:http');

async function httpFixture(handle) {
  if (process.env.AI_TEST_TRANSPORT === 'memory') return memoryHttpFixture(handle);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(raw.toString()); } catch { body = raw; }
    requests.push({ path: req.url, headers: req.headers, body, raw });
    try { await handle({ req, res, body, raw, requests }); }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const chat = (res, text = 'answer', extra = {}) => json(res, { choices: [{ message: { content: text }, ...extra }] });
// Explicit alternative for restricted environments; never presented as socket proof.
function memoryHttpFixture(handle) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const url = 'http://127.0.0.1:19001';
  globalThis.fetch = async (address, init = {}) => {
    const request = new globalThis.Request(address, init);
    const raw = Buffer.from(await request.arrayBuffer());
    let body;
    try { body = JSON.parse(raw.toString()); } catch { body = raw; }
    const req = { url: new URL(address).pathname, headers: Object.fromEntries(request.headers), async *[Symbol.asyncIterator]() { yield raw; } };
    requests.push({ path: req.url, headers: req.headers, body, raw });
    return new Promise((resolve, reject) => {
      let status = 200;
      let headers = {};
      let opened = false;
      let ended = false;
      let stream;
      const response = new globalThis.ReadableStream({ start(controller) { stream = controller; } });
      const open = () => { if (!opened) { opened = true; resolve(new globalThis.Response(response, { status, headers })); } };
      const abort = () => {
        if (!ended) { ended = true; stream.error(init.signal.reason); }
        reject(init.signal.reason);
      };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      const res = {
        writeHead(code, values = {}) { status = code; headers = values; },
        flushHeaders: open,
        write(value) { open(); if (!ended) stream.enqueue(Buffer.from(value)); },
        end(value) {
          open(); if (!ended) {
            if (value !== undefined) stream.enqueue(Buffer.from(value));
            ended = true; stream.close();
            init.signal?.removeEventListener('abort', abort);
          }
        }
      };
      Promise.resolve(handle({ req, res, body, raw, requests })).catch(() => { res.writeHead(500); res.end(); });
    });
  };
  return { url, requests, close: async () => { globalThis.fetch = originalFetch; } };
}
module.exports = { httpFixture, json, chat };
