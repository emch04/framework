'use strict';

const voice = require('@astratra/voice');
const {
  base64ToBytes,
  pcm16ToFloat,
  bytesToBase64
} = require('./protocol');
function createConfidentialCall({
  voiceOptions = {},
  transcribe,
  thinker,
  reader,
  policy,
  session,
  shield = {},
  tools,
  send,
  onFallback,
  onTurn,
  clock,
  repeatText = null,
  earlier = []
}) {
  if (typeof transcribe !== 'function' || typeof thinker !== 'function' || !reader) throw new TypeError('LOCAL_DEPENDENCY_REQUIRED');
  const decision = voice.createConfidentialSession(policy || voice.createConfidentialPolicy(), session || {});
  const segmenter = voice.createVadSegmenter({
    frameSize: voiceOptions.frameSize ?? 512,
    startFrames: 3,
    minSpeechFrames: 3,
    endFrames: 16,
    lookbackFrames: 5,
    ...voiceOptions.vad,
    onSpeechStart: () => interrupt()
  });
  const echo = voice.createEchoGuard({
    now: clock.now,
    ...voiceOptions.echo
  });
  const local = voice.createLocalTranscriber({
    transcribe: async (...args) => {
      const result = await transcribe(...args);
      if (result == null) throw Object.assign(new Error('TRANSCRIPTION_UNAVAILABLE'), {
        code: 'TRANSCRIPTION_UNAVAILABLE'
      });
      return result;
    },
    sampleRate: voiceOptions.sampleRate ?? 16000,
    ...voiceOptions.transcription
  });
  const chunker = () => voice.createSpeechChunker(voiceOptions.reading);
  let ended = false;
  let muted = false;
  let active = null;
  let queue = Promise.resolve();
  const pendingJobs = new Set();
  let sequence = 0;
  let pendingQuestion = null;
  const history = earlier.map(turn => ({
    who: turn.who || (turn.role === 'user' ? 'person' : 'assistant'),
    text: String(turn.text || '')
  }));
  const protect = (kind, value) => typeof shield[kind] === 'function' ? shield[kind](value) : value;
  function interrupt() {
    if (!active) return;
    if (!active.audioSent) {
      pendingQuestion = active.question;
      thinker.undoLast?.();
    } else if (active.spoken.length) {
      onTurn?.({
        who: 'assistant',
        text: active.spoken.join(' ')
      });
    }
    active.controller.abort();
    active = null;
    reader.interrupt?.();
    echo.playbackInterrupted();
    send({
      type: 'interrupted'
    });
  }
  async function speak(text, run) {
    if (!text || run.controller.signal.aborted) return;
    const clear = protect('output', text);
    history.push({
      who: 'assistant',
      text: clear
    });
    send({
      type: 'said',
      text: clear
    });
    const sendPiece = piece => {
      if (run.controller.signal.aborted || !piece?.audio) return;
      const audio = Buffer.from(piece.audio);
      echo.playbackSent(audio.length, voiceOptions.outputRate ?? 24000);
      if (!run.audioSent) run.spoken.push(clear);
      run.audioSent = true;
      send({
        type: 'audio',
        data: bytesToBase64(audio),
        mimeType: piece.mimeType || 'audio/pcm;rate=24000'
      });
    };
    let result;
    try {
      result = await reader.synthesize({
        text: clear,
        language: session.language,
        signal: run.controller.signal,
        onPiece: sendPiece,
        onReset: () => {
          echo.playbackInterrupted();
          send({ type: 'interrupted' });
        }
      });
    } catch (_error) {
      send({
        type: 'error',
        reason: 'VOICE_UNAVAILABLE'
      });
      return;
    }
    if (run.controller.signal.aborted) return;
    if (result?.code === 'VOICE_UNAVAILABLE') send({ type: 'error', reason: 'VOICE_UNAVAILABLE' });
    if (!result?.streamed) for (const piece of result?.pieces || [result]) sendPiece(piece);
  }
  async function processText(text, uncertain = false, audio = null) {
    if (ended) return;
    if (uncertain) {
      const verdict = decision.onDoubt();
      send({
        type: 'heard',
        text,
        uncertain: true
      });
      send({
        type: 'repeat',
        code: verdict.reason
      });
      if (repeatText) {
        send({
          type: 'said',
          text: repeatText,
          uncertain: true
        });
        try {
          const audio = await reader.synthesize({
            text: repeatText,
            language: session.language
          });
          for (const piece of audio?.pieces || [audio]) if (piece?.audio) send({
            type: 'audio',
            data: bytesToBase64(Buffer.from(piece.audio)),
            mimeType: piece.mimeType || 'audio/pcm;rate=24000'
          });
        } catch (_error) {/* The repeat code remains available to the client. */}
      }
      send({
        type: 'turn'
      });
      if (verdict.mode === 'normal') await onFallback?.(verdict.reason, audio);
      return;
    }
    decision.onAccepted();
    interrupt();
    history.push({
      who: 'person',
      text
    });
    onTurn?.({
      who: 'person',
      text
    });
    send({
      type: 'heard',
      text
    });
    const question = pendingQuestion ? `${pendingQuestion} ${text}` : text;
    pendingQuestion = null;
    const run = {
      id: ++sequence,
      question,
      audioSent: false,
      spoken: [],
      controller: new globalThis.AbortController()
    };
    active = run;
    const pieces = chunker();
    let reading = Promise.resolve();
    const spoken = [];
    const emit = part => {
      for (const piece of pieces.push(part)) {
        spoken.push(piece);
        reading = reading.then(() => speak(piece, run));
      }
    };
    try {
      const result = await thinker({
        text: protect('input', question),
        history: history.map(turn => ({
          ...turn,
          text: protect('input', turn.text)
        })),
        tools,
        signal: run.controller.signal,
        onText: emit
      });
      if (typeof result === 'string' && spoken.length === 0) emit(result);
      for (const piece of pieces.flush()) {
        spoken.push(piece);
        reading = reading.then(() => speak(piece, run));
      }
      await reading;
      if (active === run) {
        send({
          type: 'turn'
        });
        active = null;
        onTurn?.({
          who: 'assistant',
          text: spoken.map(piece => protect('output', piece)).join(' ')
        });
      }
    } catch (_error) {
      if (active === run) {
        active = null;
        send({
          type: 'error',
          reason: 'THINKER_FAILED'
        });
      }
    }
  }
  async function processSegment(samples) {
    try {
      const result = await local.transcribe(samples, {
        language: session.language
      });
      const doubtful = result.doubtful || (
        Number.isFinite(result.confidence) &&
        result.confidence < (voiceOptions.minConfidence ?? 0.35)
      );
      await processText(result.text, doubtful, samples);
    } catch (_error) {
      const verdict = decision.onLocalFailure();
      if (verdict.mode === 'normal') await onFallback?.(verdict.reason, samples);else if (verdict.state === 'ended') {
        send({
          type: 'error',
          reason: 'LOCAL_UNAVAILABLE'
        });
        end();
      } else send({
        type: 'repeat',
        code: verdict.reason
      });
    }
  }
  function scheduleSegment(samples) {
    const job = processSegment(samples);
    pendingJobs.add(job);
    void job.finally(() => pendingJobs.delete(job));
  }
  async function receive(message) {
    if (ended) return;
    if (message.type === 'mute') {
      muted = true;
      queue = queue.then(async () => {
        for (const segment of segmenter.flush()) scheduleSegment(segment);
      });
      await queue;
      await Promise.all([...pendingJobs]);
      return;
    }
    if (message.type === 'unmute') {
      muted = false;
      return;
    }
    if (message.type === 'interrupt') {
      interrupt();
      return;
    }
    if (message.type === 'text') {
      return processText(String(message.text || '').trim());
    }
    if (message.type !== 'audio' || muted) return;
    queue = queue.then(async () => {
      const samples = pcm16ToFloat(base64ToBytes(message.data));
      const guarded = await echo.filter(samples);
      if (!guarded) return;
      for (const segment of await segmenter.push(guarded)) scheduleSegment(segment);
    });
    await queue;
    await Promise.all([...pendingJobs]);
  }
  function end() {
    if (ended) return;
    ended = true;
    interrupt();
    segmenter.reset();
    decision.end();
    reader.close?.();
  }
  return {
    receive,
    end,
    flush: async () => {
      await queue;
      for (const segment of segmenter.flush()) scheduleSegment(segment);
      await Promise.all([...pendingJobs]);
    },
    snapshot: decision.snapshot,
    get history() {
      return history.slice();
    },
    get busy() {
      return Boolean(active);
    }
  };
}
module.exports = {
  createConfidentialCall
};
