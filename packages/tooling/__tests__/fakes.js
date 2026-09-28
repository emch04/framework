const crypto = require('crypto');

let cachedKeys = null;

/** One RSA and one P-256 key pair per test file: real signatures, verified in tests. */
function testKeys() {
  if (!cachedKeys) {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    cachedKeys = {
      rsa,
      ec,
      rsaPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ecPem: ec.privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
  }
  return cachedKeys;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) {
        throw new Error('no body');
      }
      return body;
    },
    arrayBuffer: async () => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || ''));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    }
  };
}

/**
 * A fetch that answers from a list of [matcher, handler] routes and records
 * every call. A matcher is a string (prefix of "METHOD url") or a RegExp.
 */
function createFakeFetch(routes) {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ method, url, init });
    for (const [matcher, handler] of routes) {
      const hit = matcher instanceof RegExp ? matcher.test(key) : key.startsWith(matcher);
      if (hit) {
        return typeof handler === 'function' ? handler({ method, url, init, calls }) : handler;
      }
    }
    throw Object.assign(new Error(`unexpected ${key}`), { code: 'ENOTFOUND' });
  };
  fakeFetch.calls = calls;
  return fakeFetch;
}

/** A runProcess double: `handler(command, args, options)` returns { code, stdout }. */
function createFakeRunner(handler) {
  const calls = [];
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    const result = (await handler(command, args, options)) || {};
    const stdout = result.stdout || '';
    if (options.onLine && !options.quiet && !options.quietStdout) {
      stdout.split('\n').filter((line) => line.trim()).forEach((line) => options.onLine(line));
    }
    return { code: result.code === undefined ? 0 : result.code, stdout, stderr: result.stderr || '' };
  };
  run.calls = calls;
  return run;
}

module.exports = {
  createFakeFetch,
  createFakeRunner,
  jsonResponse,
  testKeys
};
