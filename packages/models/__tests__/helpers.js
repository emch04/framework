/* A fake fetch: each call is recorded, the handler decides the answer.
   handler(url, init, n) returns { status, body } | { status, raw } (invalid JSON)
   | 'hang' (waits for the abort signal) | throws (network error). */
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const answer = await handler(url, init, calls.length);
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return {
      status: answer.status,
      json: async () => {
        if (answer.raw !== undefined) throw new SyntaxError('Unexpected token');
        return answer.body;
      }
    };
  };
  fetch.calls = calls;
  return fetch;
}

const ok = (body) => ({ status: 200, body });
const error = (status, code) => ({ status, body: { error: { code, message: `${code} message` } } });

module.exports = { fakeFetch, ok, error };
