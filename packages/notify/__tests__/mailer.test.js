const { createMailer, createCaptureChannel } = require('../src');

const LF = String.fromCharCode(10);

function build(overrides = {}) {
  const capture = createCaptureChannel({ from: 'no-reply@acme.cd', fromName: 'Acme' });
  const alerts = createCaptureChannel({ from: 'alerts@acme.cd', fromName: 'Acme Alerts' });
  const logs = [];
  const mailer = createMailer({
    channels: { transactional: capture, alerts },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...overrides
  });
  return { mailer, capture, alerts, logs };
}

const message = { to: 'jean@ecole.cd', subject: 'Votre commande', text: 'Merci.' };

describe('sending', () => {
  test('sends through the default channel', async () => {
    const { mailer, capture } = build();

    const result = await mailer.send(message);

    expect(result).toMatchObject({ sent: true, channel: 'transactional', to: ['jean@ecole.cd'] });
    expect(capture.last()).toMatchObject({ from: '"Acme" <no-reply@acme.cd>', subject: 'Votre commande' });
  });

  test('a named channel keeps its own sender and credentials', async () => {
    const { mailer, alerts, capture } = build();

    await mailer.send({ ...message, channel: 'alerts' });

    /* A receipt and a security alert should not travel on the same
       reputation, nor share credentials. */
    expect(alerts.last().from).toBe('"Acme Alerts" <alerts@acme.cd>');
    expect(capture.sent).toHaveLength(0);
  });

  test('several recipients arrive as a list', async () => {
    const { mailer, capture } = build();

    await mailer.send({ ...message, to: ['a@x.cd', 'b@x.cd'] });

    expect(capture.last().to).toEqual(['a@x.cd', 'b@x.cd']);
  });

  test('one bad address in a list does not lose the others', async () => {
    /* Providers reject the whole message for a single malformed address, so
       one typo would silently cost every other recipient. */
    const { mailer, capture } = build();

    const result = await mailer.send({ ...message, to: ['a@x.cd', 'pas-une-adresse', 'b@x.cd'] });

    expect(result.sent).toBe(true);
    expect(capture.last().to).toEqual(['a@x.cd', 'b@x.cd']);
  });

  test('the sender name can be overridden per message', async () => {
    const { mailer, capture } = build();

    await mailer.send({ ...message, fromName: 'École Sainte-Marie' });

    expect(capture.last().from).toBe('"École Sainte-Marie" <no-reply@acme.cd>');
  });

  test('a reply-to is carried when valid, dropped when not', async () => {
    const { mailer, capture } = build();

    await mailer.send({ ...message, replyTo: 'contact@ecole.cd' });
    expect(capture.last().replyTo).toBe('contact@ecole.cd');

    await mailer.send({ ...message, replyTo: 'pas une adresse' });
    expect(capture.last().replyTo).toBeUndefined();
  });
});

describe('a failed send never fails the caller', () => {
  test('a transport that throws returns a result instead of raising', async () => {
    /* The order is placed and the money taken. An SMTP timeout must not
       become a 500 telling the customer their order failed. */
    const broken = { from: 'no-reply@acme.cd', send: async () => { throw new Error('smtp timeout'); } };
    const { mailer } = build({ channels: { transactional: broken } });

    const result = await mailer.send(message);

    expect(result).toMatchObject({ sent: false, reason: 'send-failed', error: 'smtp timeout' });
  });

  test('the failure is logged, never swallowed in silence', async () => {
    const broken = { from: 'no-reply@acme.cd', send: async () => { throw new Error('smtp timeout'); } };
    const { mailer, logs } = build({ channels: { transactional: broken } });

    await mailer.send(message);

    expect(logs.join(' ')).toMatch(/smtp timeout/);
  });

  test('a channel with no sender address logs and carries on', async () => {
    /* A product with no mail credentials in development should not fall over
       on every signup. */
    const unconfigured = { send: async () => {} };
    const { mailer } = build({ channels: { transactional: unconfigured } });

    await expect(mailer.send(message)).resolves.toMatchObject({ sent: false, reason: 'no-sender' });
  });

  test('an unknown channel is reported, not thrown', async () => {
    const { mailer } = build();

    await expect(mailer.send({ ...message, channel: 'nope' }))
      .resolves.toMatchObject({ sent: false, reason: 'unknown-channel' });
  });
});

describe('what is refused before it leaves', () => {
  test('nothing valid to send to', async () => {
    const { mailer, capture } = build();

    for (const to of [undefined, '', 'pas une adresse', []]) {
      expect(await mailer.send({ ...message, to })).toMatchObject({ sent: false, reason: 'no-recipient' });
    }
    expect(capture.sent).toHaveLength(0);
  });

  test('no subject, and no body', async () => {
    const { mailer } = build();

    expect(await mailer.send({ ...message, subject: '' })).toMatchObject({ reason: 'no-subject' });
    expect(await mailer.send({ to: 'a@x.cd', subject: 'Hé' })).toMatchObject({ reason: 'no-body' });
  });

  test('an html-only message is accepted', async () => {
    const { mailer } = build();

    expect(await mailer.send({ to: 'a@x.cd', subject: 'Hé', html: '<p>Bonjour</p>' })).toMatchObject({ sent: true });
  });
});

describe('injection cannot reach the transport', () => {
  test('a subject carrying a break arrives on one line', async () => {
    const { mailer, capture } = build();

    await mailer.send({ ...message, subject: `Commande${LF}Bcc: tout@le-monde.cd` });

    expect(capture.last().subject).not.toContain(LF);
    expect(capture.last().subject).toBe('Commande Bcc: tout@le-monde.cd');
  });

  test('a sender name carrying a break cannot add a header', async () => {
    const { mailer, capture } = build();

    await mailer.send({ ...message, fromName: `Acme${LF}Bcc: x@y.cd` });

    expect(capture.last().from).not.toContain(LF);
  });

  test('a recipient carrying a break is dropped entirely', async () => {
    const { mailer } = build();

    expect(await mailer.send({ ...message, to: `jean@ecole.cd${LF}Bcc: x@y.cd` }))
      .toMatchObject({ sent: false, reason: 'no-recipient' });
  });
});

describe('wiring', () => {
  test('a mailer with no channel, or a channel that cannot send, is refused up front', () => {
    expect(() => createMailer({ channels: {} })).toThrow(/at least one channel/);
    expect(() => createMailer({ channels: { x: {} } })).toThrow(/send\(\)/);
  });

  test('a default channel that does not exist is refused up front', () => {
    expect(() => createMailer({ channels: { a: createCaptureChannel() }, defaultChannel: 'b' }))
      .toThrow(/not a declared channel/);
  });

  test('the capture channel can be emptied between assertions', async () => {
    const { mailer, capture } = build();
    await mailer.send(message);

    capture.clear();

    expect(capture.sent).toHaveLength(0);
    expect(capture.last()).toBeNull();
  });
});
