const { createVadSegmenter, createVadSpeechGate, createEchoGuard, chainEchoGuards, energyClassifier } = require('../src');
const sound = (count = 4) => new Float32Array(count).fill(0.5);
const quiet = (count = 4) => new Float32Array(count);

test('energy classifier separates quiet and loud frames', () => {
  expect(energyClassifier(quiet())).toBe(0);
  expect(energyClassifier(sound())).toBe(1);
});
test('VAD buffers a partial frame until complete', async () => {
  const seen = [];
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, endFrames: 1, classify: (frame) => { seen.push(frame.length); return 1; } });
  await gate.push(sound(2));
  expect(seen).toEqual([]);
  await gate.push(sound(2));
  expect(seen).toEqual([4]);
});
test('VAD processes several frames in one push', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, endFrames: 1 });
  expect((await gate.push(Float32Array.from([...sound(), ...quiet()])))).toHaveLength(1);
});
test('pre-roll keeps the quiet frame before speech', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, endFrames: 1, lookbackFrames: 1 });
  await gate.push(quiet()); await gate.push(sound());
  expect((await gate.push(quiet()))[0].slice(0, 4)).toEqual(quiet());
});
test('short false start below min speech is discarded', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, endFrames: 1, minSpeechFrames: 2 });
  await gate.push(sound());
  expect(await gate.push(quiet())).toEqual([]);
});
test('hangover retains trailing quiet frames', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, endFrames: 2 });
  await gate.push(sound()); await gate.push(quiet());
  expect((await gate.push(quiet()))[0]).toHaveLength(12);
});
test('maximum length splits long speech into segments', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, maxFrames: 2, endFrames: 2 });
  await gate.push(sound());
  expect((await gate.push(sound()))[0]).toHaveLength(8);
  await gate.push(sound());
  expect(gate.flush()[0]).toHaveLength(4);
});
test('flush processes a partial tail and emits active speech', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1 });
  await gate.push(sound()); await gate.push(sound(2));
  expect(gate.flush()[0]).toHaveLength(6);
});
test('reset discards buffered speech and partial frame', async () => {
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1 });
  await gate.push(sound()); await gate.push(sound(2)); gate.reset();
  expect(gate.flush()).toEqual([]);
});
test('classifier failure switches to energy for later frames', async () => {
  let calls = 0;
  const gate = createVadSegmenter({ frameSize: 4, startFrames: 1, classify: () => { calls++; throw new Error(); } });
  await gate.push(sound()); await gate.push(sound());
  expect(calls).toBe(1);
});
test('speech gate turns non-speech frames into equal-length silence', async () => {
  const gate = createVadSpeechGate({ frameSize: 4, lookbackFrames: 0, hangFrames: 0 });
  expect(await gate.push(quiet())).toEqual(quiet());
  expect(await gate.push(sound())).toEqual(sound());
});
test('speech gate pre-roll releases sound immediately before speech', async () => {
  const gate = createVadSpeechGate({ frameSize: 4, lookbackFrames: 1, hangFrames: 0 });
  expect(await gate.push(quiet())).toHaveLength(0);
  expect(await gate.push(sound())).toEqual(quiet());
  expect(gate.flush()).toEqual(sound());
});
test('speech gate hangover preserves trailing frame', async () => {
  const gate = createVadSpeechGate({ frameSize: 4, lookbackFrames: 0, hangFrames: 1 });
  await gate.push(sound());
  expect(await gate.push(quiet())).toEqual(quiet());
});
test('speech gate handles partial frame boundaries', async () => {
  const gate = createVadSpeechGate({ frameSize: 4, lookbackFrames: 0 });
  expect(await gate.push(sound(2))).toHaveLength(0);
  expect(await gate.push(sound(2))).toEqual(sound());
});
test('speech gate classifier failure releases held audio and passes future audio', async () => {
  let calls = 0;
  const gate = createVadSpeechGate({ frameSize: 4, lookbackFrames: 1, classify: () => { calls++; if (calls === 2) throw new Error(); return 0; } });
  await gate.push(sound());
  expect(await gate.push(sound())).toHaveLength(8);
  expect(await gate.push(sound())).toEqual(sound());
  expect(calls).toBe(2);
});
test('echo guard skips comparison outside playback window', async () => {
  let now = 0; let calls = 0;
  const guard = createEchoGuard({ now: () => now, tailMs: 50, compare: () => { calls++; return 1; } });
  guard.playbackSent(320, 16000);
  now = 61;
  expect((await guard.inspect(sound())).reason).toBe('NO_PLAYBACK');
  expect(calls).toBe(0);
});
test('queued playback extends the active window', async () => {
  let now = 0;
  const guard = createEchoGuard({ now: () => now, tailMs: 0, compare: () => 1 });
  guard.playbackSent(320, 16000); guard.playbackSent(320, 16000);
  now = 15;
  expect((await guard.inspect(sound())).reason).toBe('ECHO_DROPPED');
});
test('interrupted playback retains only configured echo tail', async () => {
  let now = 0;
  const guard = createEchoGuard({ now: () => now, tailMs: 5, compare: () => 1 });
  guard.playbackSent(3200, 16000); guard.playbackInterrupted();
  now = 6;
  expect((await guard.inspect(sound())).reason).toBe('NO_PLAYBACK');
});
test('different speaker passes with a reason', async () => {
  const guard = createEchoGuard({ compare: () => 0.2 }); guard.setPlaying(true);
  expect((await guard.inspect(sound())).reason).toBe('SPEAKER_PASSED');
});
test('comparator failure passes segment with a reason', async () => {
  const guard = createEchoGuard({ compare: () => { throw new Error(); } }); guard.setPlaying(true);
  expect((await guard.inspect(sound())).reason).toBe('COMPARATOR_UNAVAILABLE');
});
test('short segment is conservatively dropped during playback', async () => {
  const guard = createEchoGuard({ compare: () => 0, minSamples: 8 }); guard.setPlaying(true);
  expect((await guard.inspect(sound())).reason).toBe('TOO_SHORT_TO_COMPARE');
});
test('echo stream holds audio until comparison window fills', async () => {
  const guard = createEchoGuard({ compare: () => 1, windowSamples: 8, minSamples: 4 });
  guard.setPlaying(true);
  expect(await guard.push(sound())).toEqual({ segment: null, reason: 'HELD_FOR_COMPARISON' });
  expect((await guard.push(sound())).reason).toBe('ECHO_DROPPED');
});
test('echo stream releases a different speaker after comparison', async () => {
  const guard = createEchoGuard({ compare: () => 0, windowSamples: 8, minSamples: 4 });
  guard.setPlaying(true);
  await guard.push(sound());
  expect((await guard.push(sound())).segment).toHaveLength(8);
});
test('echo stream drops too-short held audio when playback ends', async () => {
  const guard = createEchoGuard({ compare: () => 0, windowSamples: 8, minSamples: 6 });
  guard.setPlaying(true); await guard.push(sound()); guard.setPlaying(false);
  expect((await guard.push(quiet())).reason).toBe('TOO_SHORT_TO_COMPARE');
});
test('echo stream passes audio after comparator failure', async () => {
  const guard = createEchoGuard({ compare: () => { throw new Error(); }, windowSamples: 8 });
  guard.setPlaying(true); await guard.push(sound());
  expect((await guard.push(sound())).reason).toBe('COMPARATOR_UNAVAILABLE');
});
test('echo comparison excludes exact silence from speaker samples', async () => {
  let compared;
  const guard = createEchoGuard({ compare: (samples) => { compared = samples; return 0; }, windowSamples: 8, minSamples: 4 });
  guard.setPlaying(true);
  await guard.push(sound());
  await guard.push(quiet());
  expect(compared).toHaveLength(4);
});
test('exact silence bypasses speaker comparison', async () => {
  let calls = 0;
  const guard = createEchoGuard({ compare: () => { calls++; return 1; } }); guard.setPlaying(true);
  expect((await guard.inspect(quiet())).reason).toBe('NO_SOUND');
  expect(calls).toBe(0);
});
test('silence closes a held echo window and remains in the stream', async () => {
  const guard = createEchoGuard({ compare: () => 1, windowSamples: 8, minSamples: 4 }); guard.setPlaying(true);
  await guard.push(sound());
  expect(await guard.push(quiet())).toEqual({ segment: quiet(), reason: 'ECHO_DROPPED' });
});
test('a recognized different speaker continues within the pass gap', async () => {
  let now = 0; let calls = 0;
  const guard = createEchoGuard({ now: () => now, compare: () => { calls++; return 0; }, windowSamples: 4, passGapMs: 300 });
  guard.setPlaying(true);
  expect((await guard.push(sound())).reason).toBe('SPEAKER_PASSED');
  now = 100;
  expect((await guard.push(sound())).reason).toBe('SPEAKER_CONTINUES');
  expect(calls).toBe(1);
});
test('chained guards pass only audio accepted by every guard', async () => {
  const chain = chainEchoGuards(null, { filter: async (segment) => segment }, { filter: async () => null });
  expect(await chain.filter(sound())).toBeNull();
});
test('chained guards forward playback events to all members', () => {
  const calls = [];
  const one = { filter: async (segment) => segment, playbackSent: () => calls.push('one'), playbackInterrupted: () => calls.push('stop-one') };
  const two = { filter: async (segment) => segment, playbackSent: () => calls.push('two'), playbackInterrupted: () => calls.push('stop-two') };
  const chain = chainEchoGuards(one, two);
  chain.playbackSent(320, 16000); chain.playbackInterrupted();
  expect(calls).toEqual(['one', 'two', 'stop-one', 'stop-two']);
});
