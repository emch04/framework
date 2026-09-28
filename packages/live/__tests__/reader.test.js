const {
  createLiveReader,
  createGeminiLiveReader
} = require('../src');
const audio = Buffer.from([1, 2]);
test('primary reader returns audio', async () => {
  const reader = createLiveReader({
    primary: {
      id: 'live',
      synthesize: async () => ({
        audio,
        spokenText: 'hello world'
      })
    }
  });
  expect((await reader.synthesize({
    text: 'hello world'
  })).provider).toBe('live');
  reader.close();
});
test('speech drift uses fallback provider', async () => {
  const reader = createLiveReader({
    primary: {
      synthesize: async () => ({
        audio,
        spokenText: 'wrong words'
      })
    },
    providers: [{
      id: 'tts',
      synthesize: async () => ({
        audio
      })
    }]
  });
  const result = await reader.synthesize({
    text: 'hello world'
  });
  expect(result.provider).toBe('tts');
  expect(result.fallback).toBe(true);
  reader.close();
});
test('primary failure uses fallback provider', async () => {
  const reader = createLiveReader({
    primary: {
      synthesize: async () => {
        throw new Error();
      }
    },
    providers: [{
      id: 'backup',
      synthesize: async () => ({
        audio
      })
    }]
  });
  expect((await reader.synthesize({
    text: 'hello world'
  })).provider).toBe('backup');
  reader.close();
});
test('fallback providers exhausted degrade to code', async () => {
  const reader = createLiveReader({
    providers: [{
      synthesize: async () => {
        throw new Error();
      }
    }]
  });
  expect((await reader.synthesize({
    text: 'hello'
  })).code).toBe('VOICE_UNAVAILABLE');
  reader.close();
});
test('no provider degrades to code', async () => {
  const reader = createLiveReader();
  expect((await reader.synthesize({
    text: 'hello'
  })).code).toBe('VOICE_UNAVAILABLE');
  reader.close();
});
test('interrupt stops pending result', async () => {
  let resolve;
  const reader = createLiveReader({
    primary: {
      synthesize: async () => new Promise(done => {
        resolve = done;
      })
    }
  });
  const pending = reader.synthesize({
    text: 'hello'
  });
  reader.interrupt();
  resolve({
    audio
  });
  expect((await pending).code).toBe('INTERRUPTED');
  reader.close();
});
test('empty text gives code', async () => {
  const reader = createLiveReader();
  expect((await reader.synthesize({
    text: ''
  })).code).toBe('TEXT_REQUIRED');
  reader.close();
});
test('closed reader gives interrupted code', async () => {
  const reader = createLiveReader();
  reader.close();
  expect((await reader.synthesize({
    text: 'hello'
  })).code).toBe('INTERRUPTED');
});
test('Gemini reader collects live audio until the turn ends', async () => {
  let events;
  const line = {
    sendText: jest.fn(),
    close: jest.fn()
  };
  const reader = createGeminiLiveReader({
    adapter: {
      connect: async options => {
        events = options.onEvent;
        return line;
      }
    },
    clock: {
      setTimeout: () => 1,
      clearTimeout: jest.fn()
    }
  });
  const pending = reader.synthesize({
    text: 'hello'
  });
  await Promise.resolve();
  events({
    type: 'audio',
    data: audio.toString('base64'),
    mimeType: 'audio/pcm;rate=24000'
  });
  events({
    type: 'said',
    text: 'hello'
  });
  events({
    type: 'turn'
  });
  const result = await pending;
  expect(result.pieces[0].audio).toEqual(audio);
  expect(line.sendText).toHaveBeenCalledWith('hello');
  expect(line.close).toHaveBeenCalled();
});
test('Gemini reader streams an audio frame before the model turn completes', async () => {
  let events;
  const pieces = [];
  const reader = createGeminiLiveReader({
    adapter: { connect: async (options) => { events = options.onEvent; return { sendText() {}, close() {} }; } },
    clock: { setTimeout: () => 1, clearTimeout() {} }
  });
  const pending = reader.synthesize({ text: 'hello', onPiece: (piece) => pieces.push(piece) });
  await Promise.resolve();
  events({ type: 'audio', data: audio.toString('base64') });
  expect(pieces).toHaveLength(1);
  events({ type: 'said', text: 'hello' });
  events({ type: 'turn' });
  expect((await pending).streamed).toBe(true);
});
test('speech drift clears streamed audio before fallback pieces', async () => {
  const delivered = [];
  const reader = createLiveReader({
    primary: {
      synthesize: async ({ onPiece }) => {
        onPiece({ audio });
        return { pieces: [{ audio }], spokenText: 'different words', streamed: true };
      }
    },
    providers: [{ id: 'backup', synthesize: async () => ({ audio }) }]
  });
  const result = await reader.synthesize({
    text: 'hello world',
    onPiece: () => delivered.push('piece'),
    onReset: () => delivered.push('reset')
  });
  expect(result.provider).toBe('backup');
  expect(delivered).toEqual(['piece', 'reset', 'piece']);
});
test('Gemini reader falls back when spoken words drift', async () => {
  let events;
  const reader = createGeminiLiveReader({
    adapter: {
      connect: async options => {
        events = options.onEvent;
        return {
          sendText() {},
          close() {}
        };
      }
    },
    clock: {
      setTimeout: () => 1,
      clearTimeout() {}
    },
    providers: [{
      id: 'backup',
      synthesize: async () => ({
        audio
      })
    }]
  });
  const pending = reader.synthesize({
    text: 'hello world'
  });
  await Promise.resolve();
  events({
    type: 'audio',
    data: audio.toString('base64')
  });
  events({
    type: 'said',
    text: 'different words entirely'
  });
  events({
    type: 'turn'
  });
  expect((await pending).provider).toBe('backup');
});
test('interrupting a live reader settles the pending turn promptly', async () => {
  const line = {
    sendText() {},
    close: jest.fn()
  };
  const reader = createGeminiLiveReader({
    adapter: {
      connect: async () => line
    },
    clock: {
      setTimeout: () => 1,
      clearTimeout() {}
    }
  });
  const pending = reader.synthesize({
    text: 'hello'
  });
  await Promise.resolve();
  await Promise.resolve();
  reader.interrupt();
  expect((await pending).code).toBe('INTERRUPTED');
  expect(line.close).toHaveBeenCalled();
});
