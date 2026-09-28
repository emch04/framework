const { splitSpeechPieces, createPieceVoiceService } = require('../src');

test('short speech remains one piece', () => {
  expect(splitSpeechPieces('One sentence.', { maxChars: 30 })).toEqual(['One sentence.']);
});
test('sentences are split without losing punctuation', () => {
  expect(splitSpeechPieces('First. Second. Third.', { maxChars: 14 })).toEqual(['First. Second.', 'Third.']);
});
test('long sentence is split at words', () => {
  const pieces = splitSpeechPieces('alpha beta gamma delta', { maxChars: 10 });
  expect(pieces).toEqual(['alpha beta', 'gamma', 'delta']);
});
test('empty text has no pieces', () => {
  expect(splitSpeechPieces('   ')).toEqual([]);
});
test('all pieces use first provider when it succeeds', async () => {
  const service = createPieceVoiceService({ providers: [{ id: 'cloud', synthesize: async ({ text }) => text.toUpperCase() }] });
  expect(await service.synthesize(['one', 'two'])).toMatchObject({ provider: 'cloud', pieces: ['ONE', 'TWO'], fallback: false });
});
test('one failed piece discards entire primary reading', async () => {
  const service = createPieceVoiceService({ providers: [
    { id: 'cloud', synthesize: async ({ text }) => { if (text === 'two') throw new Error(); return 'cloud:' + text; } },
    { id: 'local', synthesize: async ({ text }) => 'local:' + text }
  ] });
  expect(await service.synthesize(['one', 'two'])).toMatchObject({ provider: 'local', pieces: ['local:one', 'local:two'], fallback: true });
});
test('next provider starts only after all active primary pieces settle', async () => {
  const events = [];
  const service = createPieceVoiceService({ maxConcurrent: 2, providers: [
    { id: 'cloud', synthesize: async ({ text }) => { events.push('start:' + text); if (text === 'one') throw new Error(); await Promise.resolve(); events.push('end:' + text); return text; } },
    { id: 'local', synthesize: async ({ text }) => { events.push('local:' + text); return text; } }
  ] });
  await service.synthesize(['one', 'two']);
  expect(events.indexOf('end:two')).toBeLessThan(events.indexOf('local:one'));
});
test('concurrency limit bounds active syntheses', async () => {
  let active = 0; let maximum = 0;
  const service = createPieceVoiceService({ maxConcurrent: 2, providers: [{ id: 'cloud', synthesize: async ({ text }) => {
    active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return text;
  } }] });
  await service.synthesize(['one', 'two', 'three', 'four']);
  expect(maximum).toBe(2);
});
test('missing providers return a code', async () => {
  await expect(createPieceVoiceService({ providers: [] }).synthesize(['one'])).rejects.toMatchObject({ code: 'PROVIDERS_UNAVAILABLE' });
});
test('piece result contains no failed provider audio', async () => {
  const service = createPieceVoiceService({ providers: [
    { id: 'cloud', synthesize: async ({ text }) => { if (text === 'two') throw new Error(); return 'bad-audio'; } },
    { id: 'local', synthesize: async ({ text }) => 'good:' + text }
  ] });
  expect((await service.synthesize(['one', 'two'])).pieces).toEqual(['good:one', 'good:two']);
});
