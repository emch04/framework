'use strict';

const PHASES = new Set(['connecting', 'listening', 'thinking', 'speaking', 'confirming', 'reconnecting', 'ended']);
const MESSAGE_TYPES = new Set([
  'audio', 'text', 'image', 'mute', 'unmute', 'interrupt', 'confirm', 'cancel',
  'end', 'mode', 'ready', 'heard', 'said', 'turn', 'tool', 'tool_done', 'error',
  'idle', 'saved', 'action_done', 'action_cancelled', 'fallback', 'quota',
  'interrupted', 'switching', 'repeat'
]);
function encodeMessage(message) {
  if (!message || !MESSAGE_TYPES.has(message.type)) throw new TypeError('INVALID_MESSAGE');
  return JSON.stringify(message);
}
function decodeMessage(raw, {
  maxBytes = 256 * 1024
} = {}) {
  const value = typeof raw === 'string' ? raw : String(raw);
  if (globalThis.Buffer ? globalThis.Buffer.byteLength(value) > maxBytes : new globalThis.TextEncoder().encode(value).length > maxBytes) return null;
  try {
    const message = JSON.parse(value);
    return message && !Array.isArray(message) && MESSAGE_TYPES.has(message.type) ? message : null;
  } catch (_error) {
    return null;
  }
}
function nextCallState(state = {
  phase: 'connecting',
  reason: null,
  muted: false
}, event = {}) {
  if (state.phase === 'ended') return state;
  const phase = {
    ready: 'listening',
    audio: 'speaking',
    heard: 'thinking',
    text: 'thinking',
    said: 'speaking',
    confirm: 'confirming',
    switching: 'reconnecting',
    turn: 'listening',
    interrupted: 'listening',
    end: 'ended',
    error: 'ended',
    idle: 'ended'
  }[event.type] || state.phase;
  return {
    ...state,
    phase: PHASES.has(phase) ? phase : state.phase,
    muted: event.type === 'mute' ? true : event.type === 'unmute' ? false : state.muted,
    reason: phase === 'ended' ? event.reason || event.type.toUpperCase() : null
  };
}
function floatToPcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    view.setInt16(i * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return bytes;
}
function pcm16ToFloat(bytes) {
  if (bytes.length % 2) throw new RangeError('INVALID_PCM16');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({
    length: bytes.length / 2
  }, (_, i) => view.getInt16(i * 2, true) / 32768);
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
function base64ToBytes(value) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(value, 'base64'));
  return Uint8Array.from(globalThis.atob(value), char => char.charCodeAt(0));
}
function resample(samples, from, to) {
  if (!(from > 0 && to > 0)) throw new RangeError('INVALID_AUDIO_RATE');
  if (from === to) return Float32Array.from(samples);
  const out = new Float32Array(Math.round(samples.length * to / from));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * from / to;
    const left = Math.floor(position);
    const fraction = position - left;
    out[i] = (samples[left] || 0) * (1 - fraction) + (samples[Math.min(left + 1, samples.length - 1)] || 0) * fraction;
  }
  return out;
}
function audioLevel(samples) {
  if (!samples.length) return 0;
  return Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 5);
}
function encodeMicroChunk(samples, inputRate, outputRate = 16000) {
  return bytesToBase64(floatToPcm16(resample(samples, inputRate, outputRate)));
}
function decodeVoiceChunk(data) {
  return pcm16ToFloat(base64ToBytes(data));
}
function shouldInterrupt({
  level,
  playing,
  threshold = 0.55,
  mode = 'normal'
}) {
  return Boolean(playing && mode === 'confidential' && level >= threshold);
}
function createAudioPacer({
  sampleRate = 16000,
  framesPerSecond = 25,
  maxQueuedMs = 400,
  send,
  clock = {
    setTimeout,
    clearTimeout
  }
}) {
  if (typeof send !== 'function' || !(sampleRate > 0 && framesPerSecond > 0 && maxQueuedMs > 0)) throw new TypeError('INVALID_PACER');
  const frame = Math.round(sampleRate / framesPerSecond);
  const queue = [];
  let timer = null;
  let stopped = false;
  function tick() {
    timer = null;
    if (stopped || !queue.length) return;
    send(bytesToBase64(floatToPcm16(queue.shift())));
    if (queue.length) timer = clock.setTimeout(tick, 1000 / framesPerSecond);
  }
  return {
    push(samples, inputRate = sampleRate) {
      if (stopped) return 0;
      const converted = resample(samples, inputRate, sampleRate);
      for (let at = 0; at < converted.length; at += frame) queue.push(converted.slice(at, at + frame));
      const max = Math.ceil(maxQueuedMs * framesPerSecond / 1000);
      while (queue.length > max) queue.shift();
      if (timer === null && queue.length) tick();
      return queue.length;
    },
    clear() {
      queue.length = 0;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    stop() {
      stopped = true;
      this.clear();
    },
    get queued() {
      return queue.length;
    }
  };
}
module.exports = {
  PHASES,
  encodeMessage,
  decodeMessage,
  nextCallState,
  floatToPcm16,
  pcm16ToFloat,
  bytesToBase64,
  base64ToBytes,
  resample,
  audioLevel,
  encodeMicroChunk,
  decodeVoiceChunk,
  shouldInterrupt,
  createAudioPacer
};
