const { analyzeTranscription, isDoubtfulTranscription, appendTrailingSilence, confidenceFromLogProbabilities, createLocalTranscriber } = require('../src');

test('log probabilities become bounded confidence', () => {
  expect(confidenceFromLogProbabilities([Math.log(0.5), Math.log(0.5)])).toBeCloseTo(0.5);
});
test('missing or invalid log probabilities have no confidence', () => {
  expect(confidenceFromLogProbabilities([])).toBeNull();
  expect(confidenceFromLogProbabilities([NaN])).toBeNull();
});

test('empty transcription is doubtful with a code', () => {
  expect(analyzeTranscription('  ', 1000)).toMatchObject({ doubtful: true, reason: 'EMPTY_TEXT', confidence: 0.1 });
});
test('stock phrase comes from the selected language catalog', () => {
  expect(analyzeTranscription('sample closing phrase', 1000, { language: 'en', stockPhrasesByLanguage: { en: ['closing phrase'] } }).reason).toBe('STOCK_PHRASE');
});
test('a catalog in another language does not match', () => {
  expect(isDoubtfulTranscription('sample closing phrase', 1000, { language: 'fr', stockPhrasesByLanguage: { en: ['closing phrase'] } })).toBe(false);
});
test('a direct stock phrase list overrides language catalog', () => {
  expect(analyzeTranscription('sample closing phrase', 1000, { language: 'fr', stockPhrases: ['closing phrase'] }).reason).toBe('STOCK_PHRASE');
});
test('long speech with very few words is doubtful', () => {
  expect(analyzeTranscription('two words', 8000).reason).toBe('TOO_FEW_WORDS');
});
test('short speech with few words is not automatically doubtful', () => {
  expect(analyzeTranscription('hello', 500).doubtful).toBe(false);
});
test('four identical words in sequence are a loop', () => {
  expect(analyzeTranscription('again again again again', 1000).reason).toBe('WORD_LOOP');
});
test('repeating a two-word phrase is a loop', () => {
  expect(analyzeTranscription('hello there hello there hello there', 1000).reason).toBe('PHRASE_LOOP');
});
test('two distinct triple-word runs are a loop', () => {
  expect(analyzeTranscription('one one one two two two', 1000).reason).toBe('WORD_LOOP');
});
test('low model log probability marks transcript doubtful', () => {
  expect(analyzeTranscription('a clear useful sentence', 1000, { logprob: -1.2 }).reason).toBe('LOW_LOGPROB');
});
test('high no-speech probability marks transcript doubtful', () => {
  expect(analyzeTranscription('a clear useful sentence', 1000, { noSpeechProbability: 0.8 }).reason).toBe('NO_SPEECH');
});
test('vocabulary echo is detected without fixed vocabulary', () => {
  expect(analyzeTranscription('alpha beta gamma delta', 1000, { expectedVocabulary: ['alpha', 'beta', 'gamma', 'delta'] }).reason).toBe('VOCABULARY_ECHO');
});
test('mostly consonant strings are garbage', () => {
  expect(analyzeTranscription('brrr zzzz hmmm', 1000).reason).toBe('NON_WORDS');
});
test('caller can replace the non-word classifier', () => {
  expect(analyzeTranscription('red blue green', 1000, { isNonWord: (word) => word !== 'red' }).reason).toBe('NON_WORDS');
});
test('normal phrase retains supplied confidence', async () => {
  const local = createLocalTranscriber({ transcribe: async () => ({ text: 'a clear useful sentence', confidence: 0.83 }) });
  expect(await local.transcribe(new Float32Array(16000))).toMatchObject({ doubtful: false, confidence: 0.83, reason: 'ACCEPTED' });
});
test('doubtful result uses low confidence and reason', async () => {
  const local = createLocalTranscriber({ transcribe: async () => ({ text: '' }), lowConfidence: 0.2 });
  expect(await local.transcribe(new Float32Array(16000))).toMatchObject({ doubtful: true, confidence: 0.2, reason: 'EMPTY_TEXT' });
});
test('local decoder confidence metadata reaches the heuristic', async () => {
  const local = createLocalTranscriber({ transcribe: async () => ({ text: 'a clear useful sentence', confidence: 0.9, logprob: -2, noSpeechProbability: 0 }) });
  expect((await local.transcribe(new Float32Array(16000))).reason).toBe('LOW_LOGPROB');
});
test('float samples receive 500 ms of silence at their rate', () => {
  const result = appendTrailingSilence(new Float32Array([0.5, -0.5]), 1000);
  expect(result).toBeInstanceOf(Float32Array);
  expect(result.length).toBe(502);
  expect(result.slice(0, 2)).toEqual(new Float32Array([0.5, -0.5]));
});
test('PCM16 samples retain their format and receive silence', () => {
  const result = appendTrailingSilence(new Int16Array([32767, -32768]), 1000, 100);
  expect(result).toBeInstanceOf(Int16Array);
  expect(result.length).toBe(102);
  expect(result[1]).toBe(-32768);
});
test('PCM16 byte buffer is padded by two bytes per sample', () => {
  const result = appendTrailingSilence(Buffer.from([1, 2]), 1000, 100);
  expect(Buffer.isBuffer(result)).toBe(true);
  expect(result.length).toBe(202);
});
test('local decoder receives normalized PCM16 and the correct duration', async () => {
  let seen;
  const local = createLocalTranscriber({ inputFormat: 'pcm16', sampleRate: 1000, silenceMs: 100, transcribe: async (samples) => { seen = samples; return 'hello'; } });
  const result = await local.transcribe(new Int16Array([32767, -32768]));
  expect(seen).toBeInstanceOf(Float32Array);
  expect(seen).toHaveLength(102);
  expect(seen[1]).toBe(-1);
  expect(result.durationMs).toBe(2);
});
test('invalid PCM16 byte count is rejected', () => {
  expect(() => appendTrailingSilence(Buffer.from([1]), 16000)).toThrow();
});
