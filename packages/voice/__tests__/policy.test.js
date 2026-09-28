const { createConfidentialPolicy, createConfidentialSession } = require('../src');

test('default role selects confidential audio handling', () => {
  expect(createConfidentialPolicy({ defaultRoles: ['private'] }).decide({ role: 'private' })).toMatchObject({ mode: 'confidential', cloudAudioAllowed: false });
});
test('session can request confidential mode', () => {
  expect(createConfidentialPolicy().decide({ requestedMode: 'confidential' }).reason).toBe('CONFIDENTIAL_SELECTED');
});
test('session normal override can change a nonlocked default role', () => {
  expect(createConfidentialPolicy({ defaultRoles: ['private'] }).decide({ role: 'private', requestedMode: 'normal' }).mode).toBe('normal');
});
test('locked role cannot override confidential default', () => {
  expect(createConfidentialPolicy({ lockedRoles: ['private'] }).decide({ role: 'private', requestedMode: 'normal' }).reason).toBe('ROLE_LOCKED');
});
test('unsupported local language can choose normal only for unlocked sessions', () => {
  const policy = createConfidentialPolicy({ localUnsupportedLanguages: ['xx'], lockedRoles: ['private'] });
  expect(policy.decide({ language: 'xx', requestedMode: 'confidential' }).reason).toBe('LOCAL_LANGUAGE_UNAVAILABLE');
  expect(policy.decide({ role: 'private', language: 'xx' }).cloudAudioAllowed).toBe(false);
});
test('local failure needs role permission and session opt-in', () => {
  const policy = createConfidentialPolicy({ cloudFallbackRoles: ['adult'] });
  expect(policy.onLocalFailure({ role: 'adult', requestedMode: 'confidential' }).cloudAudioAllowed).toBe(false);
  expect(policy.onLocalFailure({ role: 'other', requestedMode: 'confidential', allowCloudFallback: true }).cloudAudioAllowed).toBe(false);
});
test('locked role cannot fall back despite explicit opt-in', () => {
  const policy = createConfidentialPolicy({ lockedRoles: ['private'], cloudFallbackRoles: ['private'] });
  expect(policy.onLocalFailure({ role: 'private', allowCloudFallback: true }).reason).toBe('LOCAL_FAILURE_CLOUD_DENIED');
});
test('normal mode keeps cloud permission after local failure', () => {
  const policy = createConfidentialPolicy();
  expect(policy.onLocalFailure({ requestedMode: 'normal' }).reason).toBe('NORMAL_SELECTED');
});
test('session resets doubt count on accepted transcript', () => {
  const session = createConfidentialSession(createConfidentialPolicy(), { requestedMode: 'confidential' }, { doubtLimit: 2 });
  session.onDoubt(); session.onAccepted();
  expect(session.onDoubt().reason).toBe('REPEAT_REQUESTED');
});
test('permitted session falls back after repeated doubts', () => {
  const session = createConfidentialSession(createConfidentialPolicy({ cloudFallbackRoles: ['adult'] }), { role: 'adult', requestedMode: 'confidential', allowCloudFallback: true }, { doubtLimit: 2 });
  session.onDoubt();
  expect(session.onDoubt()).toMatchObject({ mode: 'normal', reason: 'CONFIDENCE_FALLBACK' });
});
test('forbidden session keeps local mode after repeated doubts', () => {
  const session = createConfidentialSession(createConfidentialPolicy(), { requestedMode: 'confidential' }, { doubtLimit: 2 });
  session.onDoubt();
  expect(session.onDoubt()).toMatchObject({ mode: 'confidential', reason: 'REPEAT_REQUESTED' });
});
test('permitted session falls back immediately on local failure', () => {
  const session = createConfidentialSession(createConfidentialPolicy({ cloudFallbackRoles: ['adult'] }), { role: 'adult', requestedMode: 'confidential', allowCloudFallback: true });
  expect(session.onLocalFailure().reason).toBe('LOCAL_FAILURE_FALLBACK');
});
test('forbidden session ends after repeated local failures', () => {
  const session = createConfidentialSession(createConfidentialPolicy(), { requestedMode: 'confidential' }, { failureLimit: 2 });
  expect(session.onLocalFailure().reason).toBe('RETRY_LOCAL');
  expect(session.onLocalFailure()).toMatchObject({ state: 'ended', reason: 'LOCAL_UNAVAILABLE' });
});
test('ended session cannot restart through events', () => {
  const session = createConfidentialSession(createConfidentialPolicy(), {});
  session.end();
  expect(session.onDoubt().state).toBe('ended');
  expect(session.onLocalFailure().state).toBe('ended');
});
test('local failure after cloud fallback does not end the session', () => {
  const session = createConfidentialSession(createConfidentialPolicy({ cloudFallbackRoles: ['adult'] }), { role: 'adult', requestedMode: 'confidential', allowCloudFallback: true }, { failureLimit: 2 });
  session.onLocalFailure(); session.onLocalFailure();
  expect(session.snapshot()).toMatchObject({ mode: 'normal', state: 'active' });
});
