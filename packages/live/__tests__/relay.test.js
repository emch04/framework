const { createConfidentialPolicy, createConfidentialSession } = require('@astratra/voice');
const { createTranscribedRelay } = require('../src');

function build({ items = [], failure = null, allowCloudFallback = true, finish = [], finishFails = false } = {}) {
  const sent = [];
  const heard = [];
  const sentences = [];
  const fallbacks = [];
  let unavailable = 0;
  const queue = [...items];
  const transcriber = {
    push: async () => { if (failure) throw failure; return queue.shift() || []; },
    finish: async () => { if (finishFails) throw new Error('model gone'); return finish; }
  };
  const decision = createConfidentialSession(createConfidentialPolicy({ cloudFallbackRoles: ['person'] }), { role: 'person', requestedMode: 'confidential', allowCloudFallback });
  const relay = createTranscribedRelay({
    transcriber, decision,
    send: (message) => sent.push(message),
    onHeard: (text) => heard.push(text),
    onSentence: (text) => sentences.push(text),
    onFallback: async (reason, audio) => { fallbacks.push([reason, audio]); },
    onUnavailable: async () => { unavailable += 1; }
  });
  return { relay, sent, heard, sentences, fallbacks, get unavailable() { return unavailable; } };
}

test('a sure sentence is shown, then handed on as text', async () => {
  const r = build({ items: [[{ text: ' Bonjour Tertius ', confidence: 0.9, audio: 'A' }, { text: '   ', confidence: 0.9 }]] });
  await r.relay.push('PCM');
  expect(r.sent).toEqual([{ type: 'heard', text: 'Bonjour Tertius' }]);
  expect(r.heard).toEqual(['Bonjour Tertius']);
  expect(r.sentences).toEqual(['Bonjour Tertius']);
});
test('a sentence without a confidence score is trusted', async () => {
  const r = build({ items: [[{ text: 'oui', confidence: null }, { text: 'non' }]] });
  await r.relay.push('PCM');
  expect(r.sentences).toEqual(['oui', 'non']);
});
test('a doubtful sentence is shown, never handed on, and the person is asked to repeat', async () => {
  const r = build({ items: [[{ text: 'le le le', confidence: 0.1, audio: 'A' }]] });
  await r.relay.push('PCM');
  expect(r.sent.map((message) => message.type)).toEqual(['heard', 'repeat']);
  expect(r.sent[0]).toMatchObject({ text: 'le le le', uncertain: true });
  expect(r.sentences).toEqual([]);
  expect(r.fallbacks).toEqual([]);
});
test('two doubtful sentences in a row move the call to normal with the second one replayed, nothing after it is read', async () => {
  const r = build({ items: [[{ text: 'a', confidence: 0.1, audio: 'A1' }], [{ text: 'b', confidence: 0.1, audio: 'A2' }, { text: 'c', confidence: 0.9 }]] });
  await r.relay.push('1');
  await r.relay.push('2');
  expect(r.sent.filter((message) => message.type === 'repeat')).toHaveLength(1);
  expect(r.fallbacks).toEqual([['CONFIDENCE_FALLBACK', 'A2']]);
  expect(r.sentences).toEqual([]);
});
test('a sure sentence between two doubtful ones starts the count again', async () => {
  const r = build({ items: [[{ text: 'a', confidence: 0.1 }, { text: 'sure', confidence: 0.9 }, { text: 'b', confidence: 0.1 }]] });
  await r.relay.push('1');
  expect(r.fallbacks).toEqual([]);
  expect(r.sent.filter((message) => message.type === 'repeat')).toHaveLength(2);
  expect(r.sentences).toEqual(['sure']);
});
test('a decoder that fails moves the call to normal with the sentence it could not read, or the sound it was given', async () => {
  const withAudio = build({ failure: Object.assign(new Error('model failed'), { audio: 'WHOLE' }) });
  await withAudio.relay.push('CHUNK');
  expect(withAudio.fallbacks).toEqual([['LOCAL_FAILURE_FALLBACK', 'WHOLE']]);
  const without = build({ failure: new Error('model failed') });
  await without.relay.push('CHUNK');
  expect(without.fallbacks).toEqual([['LOCAL_FAILURE_FALLBACK', 'CHUNK']]);
});
test('where the cloud is forbidden, a failing decoder is retried once and then ends the call', async () => {
  const r = build({ failure: new Error('model failed'), allowCloudFallback: false });
  await r.relay.push('1');
  expect(r.sent).toEqual([{ type: 'repeat', code: 'RETRY_LOCAL' }]);
  await r.relay.push('2');
  expect(r.sent.at(-1)).toEqual({ type: 'error', reason: 'LOCAL_UNAVAILABLE' });
  expect(r.unavailable).toBe(1);
  expect(r.fallbacks).toEqual([]);
});
test('where the cloud is forbidden, doubt only ever asks to repeat', async () => {
  const doubt = { text: 'x', confidence: 0.1, audio: 'A' };
  const r = build({ items: [[doubt], [doubt], [doubt]], allowCloudFallback: false });
  for (let i = 0; i < 3; i += 1) await r.relay.push('c');
  expect(r.sent.filter((message) => message.type === 'repeat')).toHaveLength(3);
  expect(r.fallbacks).toEqual([]);
});
test('what the person was still saying at hang-up is written down; a doubtful end is asked again; a failing decoder is no failure', async () => {
  const r = build({ finish: [{ text: 'dernier mot', confidence: 0.9 }, { text: 'flou', confidence: 0.2 }, { text: ' ' }] });
  await r.relay.finish();
  expect(r.sentences).toEqual(['dernier mot']);
  expect(r.sent.map((message) => message.type)).toEqual(['heard', 'heard', 'repeat']);
  const broken = build({ finishFails: true });
  await expect(broken.relay.finish()).resolves.toBeUndefined();
  expect(broken.sent).toEqual([]);
  expect(() => createTranscribedRelay({ transcriber: {} })).toThrow('LOCAL_DEPENDENCY_REQUIRED');
});
