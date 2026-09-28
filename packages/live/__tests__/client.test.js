const c = require('../src');
test.each([
  [1000, 'ended'], [4401, 'refresh'], [4409, 'failed'],
  [4429, 'failed'], [4503, 'failed'], [1006, 'failed']
])('close %s yields %s', (code, kind) => {
  expect(c.closeOutcome(code).kind).toBe(kind);
});
test.each(['IDLE', 'CALL_LIMIT', 'SERVER_CLOSED'])('normal call end preserves %s reason', reason => {
  expect(c.closeOutcome(1000, { reason })).toEqual({ kind: 'ended', code: reason });
});
test('second authentication failure is session failure', () => {
  expect(c.closeOutcome(4401, {
    refreshed: true
  })).toEqual({
    kind: 'failed',
    code: 'SESSION'
  });
});
test('server reason takes precedence over close code', () => {
  expect(c.closeOutcome(4429, {
    reason: 'DAILY_LIMIT'
  }).code).toBe('DAILY_LIMIT');
});
test('unknown server reason is ignored', () => {
  expect(c.serverReason('unknown')).toBeNull();
});
test('subtitle appends until turn boundary', () => {
  const first = c.nextSubtitle({
    text: '',
    fresh: true
  }, {
    type: 'said',
    text: 'one'
  });
  const second = c.nextSubtitle(first, {
    type: 'said',
    text: ' two'
  });
  expect(second.text).toBe('one two');
  expect(c.nextSubtitle(second, {
    type: 'turn'
  }).fresh).toBe(true);
});
test('subtitle tail keeps short text', () => {
  expect(c.subtitleTail('  short  ', 10)).toBe('short');
});
test('subtitle tail caps long text', () => {
  expect(c.subtitleTail('one two three four', 10).length).toBeLessThanOrEqual(11);
});
test('consent card collects readback and disappears on matching action', () => {
  const state = c.nextConsent(null, {
    type: 'confirm',
    actionId: 'a'
  });
  const reading = c.nextConsent(state, {
    type: 'said',
    text: 'question'
  });
  expect(reading.readback).toBe('question');
  expect(c.nextConsent(reading, {
    type: 'action_done',
    actionId: 'a'
  })).toBeNull();
});
test('other action does not clear card', () => {
  const state = {
    actionId: 'a',
    readback: ''
  };
  expect(c.nextConsent(state, {
    type: 'action_cancelled',
    actionId: 'b'
  })).toBe(state);
});
test('transcript joins adjacent speaker fragments', () => {
  const one = c.nextTranscript([], {
    type: 'heard',
    text: 'hello'
  });
  expect(c.nextTranscript(one, {
    type: 'heard',
    text: ' there'
  })).toEqual([{
    role: 'user',
    text: 'hello there'
  }]);
});
test('transcript separates alternating speakers', () => {
  expect(c.nextTranscript([{
    role: 'user',
    text: 'hello'
  }], {
    type: 'said',
    text: 'hi'
  })).toHaveLength(2);
});
test('transcript cleanup removes empty turns', () => {
  expect(c.cleanTranscript([{
    role: 'user',
    text: '  '
  }, {
    role: 'assistant',
    text: ' a   b '
  }])).toEqual([{
    role: 'assistant',
    text: 'a b'
  }]);
});
test('heard line marks uncertainty', () => {
  expect(c.nextHeard({
    text: '',
    fresh: true,
    uncertain: false
  }, {
    type: 'heard',
    text: 'maybe',
    uncertain: true
  }).uncertain).toBe(true);
});
test('heard line refreshes after reply', () => {
  expect(c.nextHeard({
    text: 'hello',
    fresh: false,
    uncertain: false
  }, {
    type: 'said'
  }).fresh).toBe(true);
});
test('URL changes HTTP to WS and encodes conversation', () => {
  expect(c.callUrl('https://example.test/api/', {
    path: '/live',
    language: 'en',
    conversationId: 'a b',
    mode: 'confidential'
  })).toBe('wss://example.test/api/live?lang=en&conversation=a%20b&mode=confidential');
});
test.each([['en-US', 'en'], ['es_ES', 'es'], ['unknown', 'fr'], [null, 'fr']])('language code %s resolves to %s', (input, expected) => {
  expect(c.languageCode(input, ['en', 'es', 'fr'], 'fr')).toBe(expected);
});
