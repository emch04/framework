const p = require('../src');
test.each([
  'audio', 'text', 'image', 'mute', 'unmute', 'interrupt', 'confirm', 'cancel',
  'end', 'mode', 'ready', 'heard', 'said', 'turn', 'tool', 'tool_done', 'error',
  'idle', 'saved', 'action_done', 'action_cancelled', 'fallback', 'quota', 'interrupted'
])('encodes and decodes %s', type => {
  expect(p.decodeMessage(p.encodeMessage({
    type
  }))).toEqual({
    type
  });
});
test.each(['garbage', '[]', '{}', '{"type":"unknown"}', 'null', 'true'])('rejects invalid payload %s', payload => {
  expect(p.decodeMessage(payload)).toBeNull();
});
test('rejects oversized payload', () => {
  expect(p.decodeMessage('{"type":"end"}', {
    maxBytes: 2
  })).toBeNull();
});
test('rejects invalid outbound messages', () => {
  expect(() => p.encodeMessage({
    type: 'unknown'
  })).toThrow('INVALID_MESSAGE');
});
test.each([
  ['ready', 'listening'], ['heard', 'thinking'], ['said', 'speaking'],
  ['confirm', 'confirming'], ['turn', 'listening'], ['end', 'ended'],
  ['error', 'ended'], ['idle', 'ended']
])('%s transitions to %s', (type, phase) => {
  expect(p.nextCallState({
    phase: 'connecting',
    reason: null,
    muted: false
  }, {
    type
  }).phase).toBe(phase);
});
test('ended state is final', () => {
  expect(p.nextCallState({
    phase: 'ended',
    reason: 'IDLE',
    muted: false
  }, {
    type: 'ready'
  }).reason).toBe('IDLE');
});
test('mute changes state', () => {
  expect(p.nextCallState({
    phase: 'listening',
    reason: null,
    muted: false
  }, {
    type: 'mute'
  }).muted).toBe(true);
});
test.each([-1, -0.5, 0, 0.5, 1])('PCM16 round trip approximates %s', sample => {
  expect(p.pcm16ToFloat(p.floatToPcm16(new Float32Array([sample])))[0]).toBeCloseTo(sample, 3);
});
test('PCM16 clamps out of range samples', () => {
  expect([...p.pcm16ToFloat(p.floatToPcm16(new Float32Array([2, -2])))].map(Math.sign)).toEqual([1, -1]);
});
test('odd PCM16 byte count is rejected', () => {
  expect(() => p.pcm16ToFloat(new Uint8Array([1]))).toThrow('INVALID_PCM16');
});
test('base64 round trips arbitrary bytes', () => {
  expect(p.base64ToBytes(p.bytesToBase64(new Uint8Array([0, 1, 255])))).toEqual(new Uint8Array([0, 1, 255]));
});
test('resampling keeps a copy at equal rates', () => {
  const input = new Float32Array([1, 0]);
  expect(p.resample(input, 2, 2)).toEqual(input);
  expect(p.resample(input, 2, 2)).not.toBe(input);
});
test('resampling interpolates', () => {
  expect(p.resample(new Float32Array([0, 1]), 2, 4)[1]).toBeCloseTo(0.5);
});
test('invalid rates are rejected', () => {
  expect(() => p.resample(new Float32Array([1]), 0, 2)).toThrow('INVALID_AUDIO_RATE');
});
test('silent audio has zero level', () => {
  expect(p.audioLevel(new Float32Array([0, 0]))).toBe(0);
});
test('loud audio is capped at one', () => {
  expect(p.audioLevel(new Float32Array([1, 1]))).toBe(1);
});
test('microphone and voice chunk helpers convert at the call rates', () => {
  const microphone = new Float32Array(480);
  microphone.fill(0.5);
  const encoded = p.encodeMicroChunk(microphone, 48000);
  expect(p.decodeVoiceChunk(encoded)).toHaveLength(160);
  expect(p.decodeVoiceChunk(encoded)[0]).toBeCloseTo(0.5, 2);
});
test.each([[0.54, true, false], [0.55, true, true], [0.9, false, false]])('interrupt rule at %s playing %s', (level, playing, expected) => {
  expect(p.shouldInterrupt({
    level,
    playing,
    mode: 'confidential'
  })).toBe(expected);
});
test('normal mode does not use local interruption rule', () => {
  expect(p.shouldInterrupt({
    level: 1,
    playing: true,
    mode: 'normal'
  })).toBe(false);
});
test('pacer sends PCM frames in order', () => {
  const sent = [];
  const timers = [];
  const pacer = p.createAudioPacer({
    sampleRate: 4,
    framesPerSecond: 2,
    maxQueuedMs: 1000,
    send: data => sent.push(p.pcm16ToFloat(p.base64ToBytes(data))),
    clock: {
      setTimeout: fn => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {}
    }
  });
  pacer.push(new Float32Array([0.25, 0.25, 0.5, 0.5]));
  expect(sent).toHaveLength(1);
  timers.shift()();
  expect(sent).toHaveLength(2);
  expect(sent[1][0]).toBeCloseTo(0.5, 3);
});
test('pacer bounds queued chunks', () => {
  const pacer = p.createAudioPacer({
    sampleRate: 10,
    framesPerSecond: 10,
    maxQueuedMs: 200,
    send: () => {},
    clock: {
      setTimeout: () => 1,
      clearTimeout: () => {}
    }
  });
  pacer.push(new Float32Array(20));
  expect(pacer.queued).toBe(1);
});
test('stopped pacer refuses new samples', () => {
  const pacer = p.createAudioPacer({
    send: () => {}
  });
  pacer.stop();
  expect(pacer.push(new Float32Array(100))).toBe(0);
});
