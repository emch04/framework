const { searchSerper } = require('../src');

const KEY = 'serper_do_not_leak_1234';

function fakeFetch(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    }
  };
}

describe('searchSerper', () => {
  test('searches within the sites asked, the key in the header; keeps https results with a title, filtered by the caller', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic: [
      { title: 'Que se passe-t-il à la mort ?', link: 'https://www.jw.org/fr/mort/', snippet: 'La Bible explique.', date: '2 janv. 2025' },
      { title: 'Hostile', link: 'https://example.com/a', snippet: 'Une polémique.' },
      { title: 'Not a page', link: 'javascript:alert(1)', snippet: '' },
      { title: 'Plain http', link: 'http://www.jw.org/fr/', snippet: '' },
      { title: '', link: 'https://www.jw.org/fr/sans-titre/', snippet: '' },
      { title: 'Philippiens 4', link: 'https://wol.jw.org/fr/wol/b/r30/lp-f/nwtsty/50/4', snippet: 'Ne vous inquiétez de rien.' }
    ] } });
    const results = await searchSerper(
      { query: 'inquiétude', sites: ['jw.org', 'wol.jw.org'], hl: 'fr' },
      { key: KEY, fetch, accept: (_found, url) => url.hostname !== 'example.com' }
    );
    expect(calls[0].url).toBe('https://google.serper.dev/search');
    expect(calls[0].init.headers['X-API-KEY']).toBe(KEY);
    expect(calls[0].body).toEqual({ q: 'inquiétude site:jw.org OR site:wol.jw.org', num: 8, hl: 'fr' });
    expect(results).toEqual([
      { title: 'Que se passe-t-il à la mort ?', url: 'https://www.jw.org/fr/mort/', snippet: 'La Bible explique.', date: '2 janv. 2025' },
      { title: 'Philippiens 4', url: 'https://wol.jw.org/fr/wol/b/r30/lp-f/nwtsty/50/4', snippet: 'Ne vous inquiétez de rien.', date: null }
    ]);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });

  test('no key: nothing is asked; a failure carries a code, never the key', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: {} });
    await expect(searchSerper({ query: 'x' }, { key: '', fetch })).rejects.toMatchObject({ code: 'WEB_SEARCH_NO_KEY' });
    expect(calls).toHaveLength(0);
    const error = await searchSerper({ query: 'x' }, { key: KEY, fetch: fakeFetch({ status: 503, body: {} }).fetch }).catch((e) => e);
    expect(error).toMatchObject({ code: 'WEB_SEARCH_FAILED', message: 'Serper answered 503' });
    expect(`${error.message}${error.stack}`).not.toContain(KEY);
  });

  test('at most num results; no sites, no scope', async () => {
    const organic = Array.from({ length: 5 }, (_, index) => ({ title: `R${index}`, link: `https://a.test/${index}` }));
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic } });
    expect(await searchSerper({ query: 'x', num: 2 }, { key: KEY, fetch })).toHaveLength(2);
    expect(calls[0].body).toEqual({ q: 'x', num: 2 });
  });
});
