const { createSmsSender, normalizePhone } = require('../src');

describe('phone normalisation', () => {
  test('strips what breaks providers, keeps the leading plus', () => {
    expect(normalizePhone('+243 810 000 000')).toBe('+243810000000');
    expect(normalizePhone('06-12-34-56-78')).toBe('0612345678');
    expect(normalizePhone('(243) 810.000.000')).toBe('243810000000');
  });

  test('too short or empty is refused, not guessed at', () => {
    for (const bad of ['', '12345', 'pas un numero', null, undefined]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });
});

describe('sending', () => {
  const build = (overrides = {}) => {
    const delivered = [];
    const logs = [];
    const sms = createSmsSender({
      transport: async (message) => { delivered.push(message); },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      ...overrides
    });
    return { sms, delivered, logs };
  };

  test('sends a normalised number and the text', async () => {
    const { sms, delivered } = build();

    const result = await sms.send('+243 810 000 000', 'Votre code : 482915');

    expect(result).toMatchObject({ sent: true, to: '+243810000000' });
    expect(delivered).toEqual([{ to: '+243810000000', text: 'Votre code : 482915' }]);
  });

  test('a failed transport returns a result — it never throws at the caller', async () => {
    const { sms } = build({ transport: async () => { throw new Error('provider down'); } });

    await expect(sms.send('+243810000000', 'x')).resolves.toMatchObject({
      sent: false, reason: 'send-failed', error: 'provider down'
    });
  });

  test('a bad number or an empty text is refused before the provider sees it', async () => {
    const { sms, delivered } = build();

    expect(await sms.send('pas un numero', 'x')).toMatchObject({ sent: false, reason: 'no-recipient' });
    expect(await sms.send('+243810000000', '  ')).toMatchObject({ sent: false, reason: 'no-text' });
    expect(delivered).toHaveLength(0);
  });

  test('an unbounded text is capped — a bug must not become a bill', async () => {
    const { sms, delivered } = build({ maxLength: 100 });

    await sms.send('+243810000000', 'a'.repeat(500));

    expect(delivered[0].text).toHaveLength(100);
    expect(delivered[0].text.endsWith('…')).toBe(true);
  });
});

describe('simulation', () => {
  test('without a transport, the send is simulated LOUDLY, never silently', async () => {
    /* A simulated send that looks real is worse than a failure: someone waits
       for a code that never left the log. */
    const logs = [];
    const sms = createSmsSender({ logger: { warn: (m) => logs.push(m), info() {}, error() {} } });

    const result = await sms.send('+243810000000', 'Votre code : 482915');

    expect(result).toMatchObject({ sent: true, simulated: true });
    expect(logs.join(' ')).toMatch(/SIMULATION/);
    expect(logs.join(' ')).toMatch(/482915/);
  });

  test('a real transport never reports simulated', async () => {
    const sms = createSmsSender({ transport: async () => {} });

    expect((await sms.send('+243810000000', 'x')).simulated).toBeUndefined();
  });
});
