const { createUtteranceSegmenter } = require('../src');

const pcm = (samples) => Buffer.from(Int16Array.from(samples).buffer).toString('base64');

test('a sentence is cut at the silence after it and transcribed on its own, the silence not decoded', async () => {
  const decoded = [];
  const segmenter = createUtteranceSegmenter({ transcribe: async (samples) => { decoded.push(samples.length); return 'Bonjour Tertius'; }, silenceMs: 80, minSpeechMs: 80, sampleRate: 1000 });
  await segmenter.push(pcm(Array(100).fill(1000)));
  const out = await segmenter.push(pcm(Array(100).fill(0)));
  expect(out.map(({ text }) => text)).toEqual(['Bonjour Tertius']);
  expect(out[0].confidence).toBeNull();
  expect(out[0].durationMs).toBe(100);
  expect(Buffer.from(out[0].audio, 'base64')).toHaveLength(200);
  await segmenter.push(pcm(Array(100).fill(0)));
  expect(decoded).toEqual([100]);
});
test('a pause shorter than the silence stays inside the sentence', async () => {
  const decoded = [];
  const segmenter = createUtteranceSegmenter({ transcribe: async (samples) => { decoded.push(samples.length); return 'une phrase'; }, silenceMs: 100, minSpeechMs: 20, sampleRate: 1000 });
  await segmenter.push(pcm([...Array(60).fill(1000), ...Array(60).fill(0), ...Array(60).fill(1000)]));
  const out = await segmenter.push(pcm(Array(120).fill(0)));
  expect(out).toHaveLength(1);
  expect(decoded).toEqual([180]);
});
test('a short noise is dropped, and finish flushes the last sentence', async () => {
  const segmenter = createUtteranceSegmenter({ transcribe: async () => 'dernier segment', silenceMs: 80, minSpeechMs: 100, sampleRate: 1000 });
  await segmenter.push(pcm(Array(50).fill(1000)));
  await segmenter.push(pcm(Array(100).fill(0)));
  expect(await segmenter.push(pcm(Array(120).fill(1000)))).toEqual([]);
  expect((await segmenter.finish()).map(({ text }) => text)).toEqual(['dernier segment']);
  expect(await segmenter.finish()).toEqual([]);
});
test('a decoder that fails rejects with the sentence, and the ones after it are decoded', async () => {
  let calls = 0;
  const segmenter = createUtteranceSegmenter({ transcribe: async () => { calls += 1; if (calls === 1) throw new Error('model gone'); return { text: 'repris', confidence: 0.9 }; }, silenceMs: 40, minSpeechMs: 20, sampleRate: 1000 });
  await segmenter.push(pcm(Array(60).fill(1000)));
  const failure = await segmenter.push(pcm(Array(60).fill(0))).catch((error) => error);
  expect(failure.message).toBe('model gone');
  expect(Buffer.from(failure.audio, 'base64')).toHaveLength(120);
  await segmenter.push(pcm(Array(60).fill(1000)));
  expect(await segmenter.push(pcm(Array(60).fill(0)))).toMatchObject([{ text: 'repris', confidence: 0.9 }]);
});
test('a text that is empty is dropped, and a confidence is kept as a number', async () => {
  const answers = ['   ', { text: 'oui', confidence: '0.2' }];
  const segmenter = createUtteranceSegmenter({ transcribe: async () => answers.shift(), silenceMs: 40, minSpeechMs: 20, sampleRate: 1000 });
  const said = [];
  for (let i = 0; i < 2; i += 1) {
    said.push(...await segmenter.push(pcm(Array(60).fill(1000))));
    said.push(...await segmenter.push(pcm(Array(60).fill(0))));
  }
  expect(said).toMatchObject([{ text: 'oui', confidence: 0.2 }]);
  expect(() => createUtteranceSegmenter({})).toThrow('TRANSCRIBE_REQUIRED');
});
test('chunks that do not fall on frame edges lose nothing, and the energy threshold is in 16-bit units', async () => {
  const decoded = [];
  const segmenter = createUtteranceSegmenter({ transcribe: async (samples) => { decoded.push(samples.length); return 'x'; }, silenceMs: 40, minSpeechMs: 20, sampleRate: 1000, threshold: 500 });
  await segmenter.push(pcm(Array(30).fill(400)));
  expect(await segmenter.finish()).toEqual([]);
  for (let i = 0; i < 6; i += 1) await segmenter.push(pcm(Array(11).fill(600)));
  await segmenter.push(pcm(Array(60).fill(0)));
  expect(decoded).toEqual([66]);
});
