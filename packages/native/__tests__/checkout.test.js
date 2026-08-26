const { createCheckoutOpener } = require('../src');

function opener(overrides = {}) {
  const calls = [];
  const linking = { openURL: async (url) => { calls.push(['linking', url]); } };
  const browser = overrides.browser === null ? null : {
    openAuthSessionAsync: async (url, returnUrl) => { calls.push(['auth', url, returnUrl]); return { type: 'success' }; },
    openBrowserAsync: async (url) => { calls.push(['browser', url]); },
    ...overrides.browser
  };
  return {
    calls,
    open: createCheckoutOpener({ linking, loadBrowser: () => browser, ...overrides.options })
  };
}

describe('createCheckoutOpener', () => {
  test('with a return link it waits for the round trip and reports the come-back', async () => {
    const { open, calls } = opener();

    await expect(open('https://pay.example/x', 'acme://paid')).resolves.toBe(true);
    expect(calls).toEqual([['auth', 'https://pay.example/x', 'acme://paid']]);
  });

  test('a person who closes the page instead of paying is not reported as returned', async () => {
    const { open } = opener({ browser: { openAuthSessionAsync: async () => ({ type: 'dismiss' }) } });

    await expect(open('https://pay.example/x', 'acme://paid')).resolves.toBe(false);
  });

  test('without a return link it opens the page and admits it cannot tell', async () => {
    const { open, calls } = opener();

    await expect(open('https://pay.example/x')).resolves.toBe(false);
    expect(calls).toEqual([['browser', 'https://pay.example/x']]);
  });

  test('no native module: the phone browser does the job, payment still goes through', async () => {
    const { open, calls } = opener({ browser: null });

    await expect(open('https://pay.example/x', 'acme://paid')).resolves.toBe(false);
    expect(calls).toEqual([['linking', 'https://pay.example/x']]);
  });

  test('a browser that throws falls back instead of stranding the payment', async () => {
    const { open, calls } = opener({ browser: { openAuthSessionAsync: async () => { throw new Error('boom'); } } });

    await expect(open('https://pay.example/x', 'acme://paid')).resolves.toBe(false);
    expect(calls).toEqual([['linking', 'https://pay.example/x']]);
  });

  test('a loader that throws is the same as no module at all', async () => {
    const calls = [];
    const open = createCheckoutOpener({
      linking: { openURL: async (url) => { calls.push(url); } },
      loadBrowser: () => { throw new Error('Cannot find native module'); }
    });

    await expect(open('https://pay.example/x')).resolves.toBe(false);
    expect(calls).toEqual(['https://pay.example/x']);
  });

  test('an old browser without the auth session still opens the page', async () => {
    const { open, calls } = opener({ browser: { openAuthSessionAsync: undefined } });

    await expect(open('https://pay.example/x', 'acme://paid')).resolves.toBe(false);
    expect(calls).toEqual([['browser', 'https://pay.example/x']]);
  });

  test('a blank url opens nothing', async () => {
    const { open, calls } = opener();

    await expect(open('')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  test('requires a way to open a link', () => {
    expect(() => createCheckoutOpener({})).toThrow(/linking/i);
  });
});
