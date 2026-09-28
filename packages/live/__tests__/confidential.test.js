const {
  createConfidentialCall,
  floatToPcm16,
  bytesToBase64
} = require('../src');
const {
  createConfidentialPolicy
} = require('@astratra/voice');
function setup(extra = {}) {
  const sent = [];
  const calls = [];
  const call = createConfidentialCall({
    transcribe: async () => ({
      text: 'hello there',
      confidence: 0.9
    }),
    thinker: async ({
      text,
      onText
    }) => {
      calls.push(text);
      onText('A short answer.');
    },
    reader: {
      synthesize: async () => ({
        audio: Buffer.from([1, 2]),
        mimeType: 'audio/pcm;rate=24000'
      })
    },
    policy: createConfidentialPolicy({
      lockedRoles: ['locked']
    }),
    session: {
      role: 'locked',
      language: 'en',
      requestedMode: 'confidential'
    },
    voiceOptions: {
      frameSize: 4,
      vad: {
        startFrames: 1,
        minSpeechFrames: 1,
        endFrames: 1,
        lookbackFrames: 0
      }
    },
    send: message => sent.push(message),
    clock: {
      now: () => 0
    },
    ...extra
  });
  return {
    call,
    sent,
    calls
  };
}
test('typed input reaches thinker and TTS', async () => {
  const {
    call,
    sent,
    calls
  } = setup();
  await call.receive({
    type: 'text',
    text: 'hello'
  });
  expect(calls).toEqual(['hello']);
  expect(sent.map(m => m.type)).toContain('audio');
  call.end();
});
test('streamed reader audio reaches the client once', async () => {
  const s = setup({
    reader: {
      synthesize: async ({ onPiece }) => {
        onPiece({ audio: Buffer.from([1, 2]) });
        return { pieces: [{ audio: Buffer.from([1, 2]) }], streamed: true };
      }
    }
  });
  await s.call.receive({ type: 'text', text: 'hello' });
  expect(s.sent.filter((event) => event.type === 'audio')).toHaveLength(1);
  s.call.end();
});
test('shield masks input and clears output', async () => {
  const {
    call,
    sent,
    calls
  } = setup({
    shield: {
      input: () => 'masked',
      output: () => 'clear'
    }
  });
  await call.receive({
    type: 'text',
    text: 'private'
  });
  expect(calls[0]).toBe('masked');
  expect(sent.find(m => m.type === 'said').text).toBe('clear');
  call.end();
});
test('doubtful local transcription asks repeat and never reaches model', async () => {
  const s = setup({
    transcribe: async () => ({
      text: '',
      confidence: 0
    })
  });
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  const quiet = bytesToBase64(floatToPcm16(new Float32Array(4)));
  await s.call.receive({
    type: 'audio',
    data: sound
  });
  await s.call.receive({
    type: 'audio',
    data: quiet
  });
  expect(s.calls).toEqual([]);
  expect(s.sent.some(m => m.type === 'repeat')).toBe(true);
  s.call.end();
});
test('mute prevents audio processing', async () => {
  const s = setup();
  await s.call.receive({
    type: 'mute'
  });
  await s.call.receive({
    type: 'audio',
    data: 'AA=='
  });
  expect(s.calls).toEqual([]);
  s.call.end();
});
test('mute flushes a captured phrase before stopping the microphone', async () => {
  const s = setup();
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  await s.call.receive({
    type: 'audio',
    data: sound
  });
  await s.call.receive({
    type: 'mute'
  });
  expect(s.calls).toEqual(['hello there']);
  s.call.end();
});
test('local failure ends locked role after repeated failures', async () => {
  const s = setup({
    transcribe: async () => {
      throw new Error('offline');
    }
  });
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  const quiet = bytesToBase64(floatToPcm16(new Float32Array(4)));
  for (let i = 0; i < 2; i += 1) {
    await s.call.receive({
      type: 'audio',
      data: sound
    });
    await s.call.receive({
      type: 'audio',
      data: quiet
    });
  }
  expect(s.sent.some(m => m.reason === 'LOCAL_UNAVAILABLE')).toBe(true);
});
test('end is idempotent', () => {
  const s = setup();
  s.call.end();
  s.call.end();
  expect(s.call.snapshot().state).toBe('ended');
});
test('two doubtful segments replay the last audio when policy permits fallback', async () => {
  const fallback = jest.fn();
  const s = setup({
    policy: createConfidentialPolicy({
      cloudFallbackRoles: ['adult']
    }),
    session: {
      role: 'adult',
      language: 'en',
      requestedMode: 'confidential',
      allowCloudFallback: true
    },
    transcribe: async () => ({
      text: '',
      confidence: 0
    }),
    onFallback: fallback
  });
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  const quiet = bytesToBase64(floatToPcm16(new Float32Array(4)));
  for (let i = 0; i < 2; i += 1) {
    await s.call.receive({
      type: 'audio',
      data: sound
    });
    await s.call.receive({
      type: 'audio',
      data: quiet
    });
  }
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback.mock.calls[0][1]).toBeInstanceOf(Float32Array);
  s.call.end();
});
test('repeat prompt comes from injected text', async () => {
  const s = setup({
    transcribe: async () => ({
      text: ''
    }),
    repeatText: 'Please repeat.'
  });
  const sound = bytesToBase64(floatToPcm16(new Float32Array([0.5, 0.5, 0.5, 0.5])));
  const quiet = bytesToBase64(floatToPcm16(new Float32Array(4)));
  await s.call.receive({
    type: 'audio',
    data: sound
  });
  await s.call.receive({
    type: 'audio',
    data: quiet
  });
  expect(s.sent.some(m => m.type === 'said' && m.text === 'Please repeat.')).toBe(true);
  s.call.end();
});
test('resumed turns reach thinker after shielding', async () => {
  let seen;
  const s = setup({
    earlier: [{
      role: 'user',
      text: 'prior secret'
    }],
    shield: {
      input: text => String(text).replace('secret', 'masked')
    },
    thinker: async input => {
      seen = input.history;
      input.onText('Answer.');
    }
  });
  await s.call.receive({
    type: 'text',
    text: 'new'
  });
  expect(seen[0]).toEqual({
    who: 'person',
    text: 'prior masked'
  });
  s.call.end();
});
test('a new phrase interrupts pending thought and merges an unanswered question', async () => {
  let finishFirst;
  const questions = [];
  const thinker = jest.fn(async ({
    text,
    onText
  }) => {
    questions.push(text);
    if (questions.length === 1) await new Promise(resolve => {
      finishFirst = resolve;
    });else onText('Answer.');
  });
  thinker.undoLast = jest.fn();
  const s = setup({
    thinker
  });
  const first = s.call.receive({
    type: 'text',
    text: 'first'
  });
  await Promise.resolve();
  await s.call.receive({
    type: 'text',
    text: 'second'
  });
  finishFirst();
  await first;
  expect(questions).toEqual(['first', 'first second']);
  expect(thinker.undoLast).toHaveBeenCalledTimes(1);
  expect(s.sent.filter(event => event.type === 'turn')).toHaveLength(1);
  s.call.end();
});
