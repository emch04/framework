'use strict';

const { createVadSpeechGate, createEchoGuard } = require('./segments');

/* 16-bit PCM in base64 (what a phone sends), as -1..1 floats and back. The scale is the same both ways, so a sample that goes through unchanged comes out as it went in, to the bit. */
function samplesFromBase64(base64) {
  const bytes = Buffer.from(String(base64), 'base64');
  const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  return Float32Array.from(pcm, (sample) => sample / 32768);
}

function base64FromSamples(samples) {
  const pcm = Int16Array.from(samples, (sample) => Math.max(-32768, Math.min(32767, Math.round(sample * 32768))));
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

/**
 * What a call's microphone hears, sorted before it reaches a model, as base64
 * PCM16 in and out: a voice goes through as it is, anything else goes on as
 * silence of the same length (a model still hears the time go by, and so knows
 * when the person has stopped). First the speech gate (noise, a television, a
 * fan), then the echo guard (the assistant's own voice heard back through the
 * speaker). Either may be left out.
 *
 * The gate never stands in a call's way: a classifier or a comparator that
 * fails lets the sound through untouched from then on.
 *
 * @param {{ vad?: object | null, echo?: object | null, now?: () => number }} [options]
 *   `vad`: options of createVadSpeechGate, or a gate; `echo`: options of createEchoGuard (dropped
 *   sound is silence, so the timing is kept), or a guard
 * @returns {{ push: (base64: string) => Promise<string>, playbackSent: (bytes: number, sampleRate: number) => void, playbackInterrupted: () => void }}
 *   `push` takes chunks in order, never overlapping, and gives back what may go on now ('' while
 *   something is held); `playbackSent` and `playbackInterrupted` tell when the assistant's voice plays
 */
function createMicrophoneGate({ vad = null, echo = null, now = Date.now } = {}) {
  const speech = vad ? (typeof vad.push === 'function' ? vad : createVadSpeechGate(vad)) : null;
  const guard = echo ? (typeof echo.push === 'function' ? echo : createEchoGuard({ now, dropAs: 'silence', ...echo })) : null;
  return {
    async push(base64) {
      let samples = samplesFromBase64(base64);
      if (speech) samples = await speech.push(samples);
      if (guard && samples.length) samples = (await guard.push(samples)).segment ?? new Float32Array(0);
      return samples.length ? base64FromSamples(samples) : '';
    },
    playbackSent(bytes, sampleRate) {
      guard?.playbackSent(bytes, sampleRate);
    },
    playbackInterrupted() {
      guard?.playbackInterrupted();
    }
  };
}

module.exports = { createMicrophoneGate };
