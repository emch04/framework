const {
  CONSENT_CODES,
  ConsentError,
  consentAudience,
  consentCopyKeys,
  consentDialogActions,
  consentState,
  createConsent,
  createMemoryConsentStore,
  mergeDecisions,
  newDecision,
  readConsentInput,
  readDecision,
  runConsentStoreContract
} = require('../src');

const yes = (decidedAt, version = 2) => ({ granted: true, version, decidedAt });
const no = (decidedAt, version = 2) => ({ granted: false, version, decidedAt });

runConsentStoreContract(() => createMemoryConsentStore());

describe('the pure rules', () => {
  test('without a decision, ASK: silence is never consent', () => {
    expect(consentState(null, 2)).toBe('required');
  });

  test('a yes on the current text is a yes; on an older text, ask again', () => {
    expect(consentState(yes('2026-09-21T10:00:00.000Z'), 2)).toBe('granted');
    expect(consentState(yes('2026-09-21T10:00:00.000Z', 1), 2)).toBe('required');
  });

  test('a refusal stays a refusal whatever the version — nobody is pestered', () => {
    expect(consentState(no('2026-09-21T10:00:00.000Z', 1), 2)).toBe('refused');
  });

  test('a malformed decision is not a decision', () => {
    expect(readDecision(null)).toBeNull();
    expect(readDecision({ granted: 'true', version: 1, decidedAt: '2026-09-21T10:00:00.000Z' })).toBeNull();
    expect(readDecision({ granted: true, version: 0, decidedAt: '2026-09-21T10:00:00.000Z' })).toBeNull();
    expect(readDecision({ granted: true, version: 1.5, decidedAt: '2026-09-21T10:00:00.000Z' })).toBeNull();
    expect(readDecision({ granted: true, version: 1, decidedAt: 'not a date' })).toBeNull();
    expect(readDecision(yes('2026-09-21T10:00:00.000Z'))).toEqual(yes('2026-09-21T10:00:00.000Z'));
  });

  test('a Date from the database reads as the same ISO instant', () => {
    expect(readDecision({ granted: true, version: 2, decidedAt: new Date('2026-09-21T10:00:00.000Z') }).decidedAt)
      .toBe('2026-09-21T10:00:00.000Z');
  });

  test('a withdrawal made on ANOTHER device wins over the yes kept here', () => {
    const here = yes('2026-09-20T10:00:00.000Z');
    const elsewhere = no('2026-09-21T10:00:00.000Z');
    expect(mergeDecisions(here, elsewhere)).toEqual({ kept: elsewhere, push: false });
  });

  test('a withdrawal made HERE offline is not erased by the server\'s older yes — it is pushed', () => {
    const here = no('2026-09-21T10:00:00.000Z');
    const server = yes('2026-09-20T10:00:00.000Z');
    expect(mergeDecisions(here, server)).toEqual({ kept: here, push: true });
  });

  test('empty server: the local copy holds and goes up; unreachable server: it holds alone', () => {
    const here = yes('2026-09-21T10:00:00.000Z');
    expect(mergeDecisions(here, null)).toEqual({ kept: here, push: true });
    expect(mergeDecisions(here, 'unavailable')).toEqual({ kept: here, push: false });
    expect(mergeDecisions(null, null)).toEqual({ kept: null, push: false });
    expect(mergeDecisions(null, 'unavailable')).toEqual({ kept: null, push: false });
  });

  test('a new decision carries the version of the text shown', () => {
    expect(newDecision(true, 2, new Date('2026-09-21T10:00:00.000Z'))).toEqual(yes('2026-09-21T10:00:00.000Z'));
    expect(() => newDecision(true, 0)).toThrow(ConsentError);
    expect(() => newDecision('yes', 2)).toThrow(TypeError);
  });

  test('a request body is validated before anything is written', () => {
    expect(readConsentInput({ granted: true, version: 2 })).toEqual({ granted: true, version: 2 });
    expect(readConsentInput({ granted: 'true', version: 2 })).toBeNull();
    expect(readConsentInput({ granted: true, version: 1001 })).toBeNull();
    expect(readConsentInput({ granted: true, version: '2' })).toBeNull();
    expect(readConsentInput(null)).toBeNull();
  });

  test('the audience is the product\'s call: only the listed roles get the simple words', () => {
    expect(consentAudience('student', { simple: ['student'] })).toBe('simple');
    for (const role of ['parent', 'teacher', undefined]) expect(consentAudience(role, { simple: ['student'] })).toBe('standard');
  });

  test('the dialog draws catalogue KEYS, never words', () => {
    const keys = consentCopyKeys('ai', 'simple');
    expect(keys.title).toBe('consent.ai.simple.title');
    expect(keys.accept).toBe('consent.accept');
    expect(consentCopyKeys('web', 'standard', { prefix: 'oracle.consent' }).lead).toBe('oracle.consent.web.standard.lead');
  });

  test('after a refusal the second button keeps it off instead of refusing again', () => {
    expect(consentDialogActions('refused')).toEqual({ primary: 'accept', secondary: 'keepDisabled' });
    expect(consentDialogActions('required')).toEqual({ primary: 'accept', secondary: 'refuse' });
  });
});

describe('createConsent', () => {
  function build({ scopes = { ai: { version: 2 }, web: { version: 1, requires: ['ai'] }, voice: { version: 1, requires: ['ai'] } }, clock } = {}) {
    let time = clock || Date.parse('2026-09-28T10:00:00.000Z');
    const store = createMemoryConsentStore();
    const changes = [];
    const consent = createConsent({ store, scopes, now: () => new Date(time), onChange: (change) => changes.push(change) });
    return { consent, store, changes, advance: (ms) => { time += ms; } };
  }

  test('nothing decided: required, and the guard says so with a code', async () => {
    const { consent } = build();
    expect((await consent.check('u1', 'ai')).state).toBe('required');
    expect(await consent.guard('u1', 'ai')).toEqual({ allowed: false, code: 'CONSENT_REQUIRED', scope: 'ai', state: 'required' });
  });

  test('grant opens the action; revoke closes it at once', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    expect(await consent.guard('u1', 'ai')).toEqual({ allowed: true });
    await consent.revoke('u1', 'ai');
    expect(await consent.guard('u1', 'ai')).toMatchObject({ allowed: false, code: 'CONSENT_REFUSED' });
  });

  test('raising the version asks everyone who said yes again, and only them', async () => {
    const store = createMemoryConsentStore();
    const v1 = createConsent({ store, scopes: { ai: { version: 1 } } });
    await v1.grant('said-yes', 'ai');
    await v1.revoke('said-no', 'ai');
    const v2 = createConsent({ store, scopes: { ai: { version: 2 } } });
    expect((await v2.check('said-yes', 'ai')).state).toBe('required');
    expect((await v2.check('said-no', 'ai')).state).toBe('refused');
    await v2.grant('said-yes', 'ai');
    expect((await v2.check('said-yes', 'ai'))).toMatchObject({ state: 'granted', decidedVersion: 2, currentVersion: 2 });
  });

  test('a client that showed an OLDER text records that version — and is asked again', async () => {
    const { consent } = build();
    const decision = await consent.grant('u1', 'ai', { version: 1 });
    expect(decision.version).toBe(1);
    expect((await consent.check('u1', 'ai')).state).toBe('required');
  });

  test('a version from the future is refused: nobody pre-approves texts not yet written', async () => {
    const { consent } = build();
    await expect(consent.grant('u1', 'ai', { version: 1000 })).rejects.toMatchObject({ code: 'CONSENT_INVALID_VERSION', statusCode: 400 });
    await expect(consent.grant('u1', 'ai', { version: 0 })).rejects.toMatchObject({ code: 'CONSENT_INVALID_VERSION' });
    expect(await consent.decision('u1', 'ai')).toBeNull();
  });

  test('a refusal is written, so never decided and refused stay different', async () => {
    const { consent } = build();
    await consent.revoke('u1', 'ai');
    expect(await consent.decision('u1', 'ai')).toMatchObject({ granted: false, version: 2 });
    expect((await consent.check('u2', 'ai')).state).toBe('required');
  });

  test('scopes are separate: a yes to the assistant is not a yes to web search', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    expect(await consent.guard('u1', 'web')).toMatchObject({ allowed: false, scope: 'web', code: 'CONSENT_REQUIRED' });
  });

  test('a scope that requires another is blocked when the prerequisite is withdrawn', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    await consent.grant('u1', 'web');
    expect(await consent.guard('u1', 'web')).toEqual({ allowed: true });
    await consent.revoke('u1', 'ai');
    expect(await consent.guard('u1', 'web')).toMatchObject({ allowed: false, scope: 'ai', code: 'CONSENT_REFUSED' });
  });

  test('the guard checks several scopes and names the first one missing', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    await consent.grant('u1', 'web');
    expect(await consent.guard('u1', ['web', 'voice'])).toMatchObject({ allowed: false, scope: 'voice' });
  });

  test('one account never benefits from another account\'s consent', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    expect((await consent.check('u2', 'ai')).state).toBe('required');
  });

  test('assert throws a 403 ConsentError carrying the code and the scope', async () => {
    const { consent } = build();
    const error = await consent.assert('u1', 'ai').catch((e) => e);
    expect(error).toBeInstanceOf(ConsentError);
    expect(error).toMatchObject({ code: CONSENT_CODES.REQUIRED, statusCode: 403, scope: 'ai' });
  });

  test('guarded() never runs the action without consent, and runs it with', async () => {
    const { consent } = build();
    const sent = [];
    const send = consent.guarded('ai', (user) => user.id, async (user, text) => { sent.push(text); return 'sent'; });
    expect(await send({ id: 'u1' }, 'Kevin a frappé sa sœur')).toEqual({ blocked: true, code: 'CONSENT_REQUIRED', scope: 'ai' });
    expect(sent).toEqual([]);
    await consent.grant('u1', 'ai');
    expect(await send({ id: 'u1' }, 'bonjour')).toBe('sent');
    expect(sent).toEqual(['bonjour']);
  });

  test('the latest decision is the one that counts, with its date', async () => {
    const { consent, advance } = build();
    await consent.grant('u1', 'ai');
    advance(60_000);
    await consent.revoke('u1', 'ai');
    expect(await consent.decision('u1', 'ai')).toEqual({ granted: false, version: 2, decidedAt: '2026-09-28T10:01:00.000Z' });
  });

  test('overview lists every scope, decided or not; export lists the decisions', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    const overview = await consent.overview('u1');
    expect(overview.map((row) => [row.scope, row.state])).toEqual([['ai', 'granted'], ['web', 'required'], ['voice', 'required']]);
    expect(await consent.exportFor('u1')).toEqual([{ scope: 'ai', granted: true, version: 2, decidedAt: '2026-09-28T10:00:00.000Z' }]);
  });

  test('forget erases the decisions of a subject — part of an account erasure', async () => {
    const { consent } = build();
    await consent.grant('u1', 'ai');
    await consent.grant('u1', 'web');
    expect(await consent.forget('u1')).toBe(2);
    expect(await consent.exportFor('u1')).toEqual([]);
  });

  test('every decision is reported to onChange, and a failing listener undoes nothing', async () => {
    const store = createMemoryConsentStore();
    const consent = createConsent({ store, scopes: { ai: { version: 2 } }, onChange: () => { throw new Error('listener down'); } });
    await expect(consent.grant('u1', 'ai')).resolves.toMatchObject({ granted: true });
    const { consent: watched, changes } = build();
    await watched.revoke('u9', 'ai');
    expect(changes).toEqual([{ subject: 'u9', scope: 'ai', granted: false, version: 2 }]);
  });

  test('an unknown scope or an empty subject is a code, not a silent pass', async () => {
    const { consent } = build();
    await expect(consent.check('u1', 'telepathy')).rejects.toMatchObject({ code: 'CONSENT_UNKNOWN_SCOPE' });
    await expect(consent.guard('', 'ai')).rejects.toMatchObject({ code: 'CONSENT_INVALID_SUBJECT' });
    await expect(consent.grant(null, 'ai')).rejects.toMatchObject({ code: 'CONSENT_INVALID_SUBJECT' });
  });

  test('wiring mistakes are refused up front', () => {
    const store = createMemoryConsentStore();
    expect(() => createConsent({ store, scopes: {} })).toThrow(/at least one scope/);
    expect(() => createConsent({ store, scopes: { ai: { version: 0 } } })).toThrow(/version/);
    expect(() => createConsent({ store, scopes: { web: { version: 1, requires: ['ai'] } } })).toThrow(/unknown scope/);
    expect(() => createConsent({ store, scopes: { a: { version: 1, requires: ['b'] }, b: { version: 1, requires: ['a'] } } })).toThrow(/require each other/);
    expect(() => createConsent({ store: {}, scopes: { ai: { version: 1 } } })).toThrow(/store/);
  });
});
