const { createMicrophoneGate } = require('../src');

/* Sound as a phone sends it: 16-bit little-endian PCM, in base64. */
const pcm = (samples) => Buffer.from(Int16Array.from(samples).buffer).toString('base64');
const samplesOf = (base64) => Array.from(new Int16Array(new Uint8Array(Buffer.from(base64, 'base64')).buffer));
const FRAME = 512;
/* A frame whose every sample carries its number: a test can tell which frames came out, and whether silenced. */
const frames = (count, first = 1) => Array.from({ length: count }, (_, i) => new Array(FRAME).fill(first + i)).flat();
/* The classifier the test plays: frame n (1-based) is speech when `speaking` says so. */
const classifyFrom = (speaking) => async (frame) => (speaking(Math.round(frame[0] * 32768)) ? 0.9 : 0.1);

test('without a gate the sound comes out as it went in, every 16-bit value, to the bit', async () => {
  const every = Array.from({ length: 65536 }, (_, i) => i - 32768);
  const gate = createMicrophoneGate();
  expect(samplesOf(await gate.push(pcm(every)))).toEqual(every);
});
test('an odd trailing byte is dropped, as the phone never sends half a sample', async () => {
  const bytes = Buffer.from([1, 0, 2, 0, 3]);
  expect(samplesOf(await createMicrophoneGate().push(bytes.toString('base64')))).toEqual([1, 2]);
});
test('the speech gate lets a voice through with its look-back and tail, and turns noise into silence of the same length', async () => {
  const gate = createMicrophoneGate({ vad: { frameSize: FRAME, classify: classifyFrom((n) => n >= 20 && n <= 22) } });
  const out = [];
  for (const start of Array.from({ length: 60 }, (_, i) => i * FRAME)) out.push(...samplesOf(await gate.push(pcm(frames(60).slice(start, start + FRAME)))));
  expect(out.length).toBe((60 - 5) * FRAME);
  const passed = new Set(out.filter((sample) => sample !== 0));
  for (let n = 20 - 5; n <= 22 + 16; n += 1) expect(passed.has(n)).toBe(true);
  expect(passed.has(20 - 5 - 1)).toBe(false);
  expect(passed.has(22 + 16 + 1)).toBe(false);
});
test('while the assistant sounds, a window of its voice goes on as silence of the same length, and nothing comes out while it fills', async () => {
  let time = 10000;
  const gate = createMicrophoneGate({ now: () => time, echo: { compare: () => 0.9, threshold: 0.36, windowSamples: 3200, minSamples: 1600, silentRun: 64 } });
  gate.playbackSent(48000 * 10, 24000);
  const chunk = (n) => new Array(640).fill(n);
  const out = [];
  for (let n = 1; n <= 5; n += 1) {
    const back = samplesOf(await gate.push(pcm(chunk(n))));
    if (n < 5) expect(back).toHaveLength(0);
    out.push(...back);
  }
  expect(out).toHaveLength(5 * 640);
  expect(out.every((sample) => sample === 0)).toBe(true);
});
test('another voice goes through as it came, in order, then straight on while it goes on; the gate hears an interruption', async () => {
  let time = 10000;
  const compared = [];
  const gate = createMicrophoneGate({ now: () => time, echo: { compare: (samples) => { compared.push(samples.length); return 0.1; }, threshold: 0.36, windowSamples: 3200, minSamples: 1600, silentRun: 64 } });
  gate.playbackSent(48000 * 10, 24000);
  const chunk = (n) => new Array(640).fill(n);
  const input = [];
  const out = [];
  for (let n = 1; n <= 5; n += 1) {
    input.push(...chunk(n));
    out.push(...samplesOf(await gate.push(pcm(chunk(n)))));
    time += 40;
  }
  expect(out).toEqual(input);
  const next = pcm(chunk(99));
  expect(await gate.push(next)).toBe(next);
  expect(compared).toEqual([3200]);
  gate.playbackInterrupted();
  time += 800;
  const later = pcm(chunk(7));
  expect(await gate.push(later)).toBe(later);
});
test('both gates in a chain: noise is silenced first, then the echo, and both hear the assistant', async () => {
  let time = 10000;
  const gate = createMicrophoneGate({
    now: () => time,
    vad: { frameSize: 4, lookbackFrames: 0, hangFrames: 0, classify: (frame) => (frame[0] > 0.5 ? 1 : 0) },
    echo: { compare: () => 0.9, threshold: 0.36, windowSamples: 4, minSamples: 1 }
  });
  const loud = 30000;
  expect(samplesOf(await gate.push(pcm([1, 1, 1, 1])))).toEqual([0, 0, 0, 0]);
  expect(samplesOf(await gate.push(pcm([loud, loud, loud, loud])))).toEqual([loud, loud, loud, loud]);
  gate.playbackSent(4800, 24000);
  expect(samplesOf(await gate.push(pcm([loud, loud, loud, loud])))).toEqual([0, 0, 0, 0]);
});
test('prebuilt gates are used as they are', async () => {
  const seen = [];
  const gate = createMicrophoneGate({ vad: { push: async (samples) => { seen.push('vad'); return samples; } }, echo: { push: async (segment) => { seen.push('echo'); return { segment }; }, playbackSent: (...args) => seen.push(args), playbackInterrupted: () => seen.push('stop') } });
  await gate.push(pcm([1, 2]));
  gate.playbackSent(10, 24000);
  gate.playbackInterrupted();
  expect(seen).toEqual(['vad', 'echo', [10, 24000], 'stop']);
});
