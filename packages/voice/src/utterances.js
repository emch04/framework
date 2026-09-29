'use strict';

function samplesFromBase64(base64) {
  const bytes = Buffer.from(String(base64), 'base64');
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
}

const rms = (samples) => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

/**
 * Cuts a call's microphone into what the person said, one sentence at a time,
 * and has each transcribed on this server: the sound is held in memory only
 * until its sentence is decoded, then dropped.
 *
 * It is made for sound a speech gate has already sorted (createMicrophoneGate:
 * what is not a voice is exact silence), so a frame is speech when its energy
 * passes `threshold`. A pause shorter than `silenceMs` stays inside the
 * sentence; a longer one ends it, and that silence is not decoded. A sentence
 * shorter than `minSpeechMs` is noise and is dropped.
 *
 * @param {{ transcribe: (samples: Float32Array) => Promise<string | { text: string, confidence?: number | null }>,
 *           sampleRate?: number, silenceMs?: number, minSpeechMs?: number, frameMs?: number, threshold?: number }} options
 *   `transcribe`: the local decoder, given a sentence as -1..1 floats (createLocalTranscriber's `transcribe`
 *   fits; a text that is empty is dropped); `threshold`: an energy on the scale of 16-bit samples
 * @returns {{ push: (base64: string) => Promise<{ text: string, confidence: number | null, audio: string, durationMs: number }[]>,
 *             finish: () => Promise<{ text: string, confidence: number | null, audio: string, durationMs: number }[]> }}
 *   `push` takes base64 PCM16 chunks, in order, and gives back the sentences that ended; `audio` is
 *   the sentence itself (base64 PCM16), so a caller that gives up on the local decoder can replay it.
 *   A decoder that fails makes `push` (or `finish`) reject, with the sentence in the error's `audio`.
 */
function createUtteranceSegmenter({ transcribe, sampleRate = 16000, silenceMs = 520, minSpeechMs = 240, frameMs = 20, threshold = 180 } = {}) {
  if (typeof transcribe !== 'function') throw new TypeError('TRANSCRIBE_REQUIRED');
  let speech = [];
  let quiet = [];
  let speechCount = 0;
  let queue = Promise.resolve();
  const count = (parts) => parts.reduce((sum, part) => sum + part.length, 0);

  /* One sentence to decode, after the ones before it. */
  function decode(out) {
    const captured = speech;
    speech = [];
    const size = speechCount;
    speechCount = 0;
    const job = queue.then(async () => {
      if (size < sampleRate * minSpeechMs / 1000 || !captured.length) return;
      const pcm = new Int16Array(count(captured));
      let at = 0;
      for (const part of captured) { pcm.set(part, at); at += part.length; }
      const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
      let decoded;
      try { decoded = await transcribe(Float32Array.from(pcm, (sample) => sample / 32768)); }
      catch (error) {
        if (error && typeof error === 'object') error.audio = audio;
        throw error;
      }
      const item = typeof decoded === 'string' ? { text: decoded } : decoded ?? {};
      const text = String(item.text ?? '').trim();
      if (text) out.push({ text, confidence: item.confidence == null ? null : Number(item.confidence), audio, durationMs: (pcm.length / sampleRate) * 1000 });
    });
    /* A decoder that failed reports it to the one waiting for that sentence; the ones after it go on. */
    queue = job.catch(() => {});
    return job;
  }

  return {
    async push(base64) {
      const out = [];
      const jobs = [];
      const samples = samplesFromBase64(base64);
      const frames = Math.max(1, Math.ceil(sampleRate * frameMs / 1000));
      for (let at = 0; at < samples.length; at += frames) {
        const frame = samples.subarray(at, Math.min(at + frames, samples.length));
        if (rms(frame) >= threshold) {
          if (quiet.length) { speech.push(...quiet); speechCount += count(quiet); quiet = []; }
          speech.push(frame.slice());
          speechCount += frame.length;
        } else if (speech.length) {
          quiet.push(frame.slice());
          if (count(quiet) >= sampleRate * silenceMs / 1000) {
            quiet = [];
            jobs.push(decode(out));
          }
        }
      }
      await Promise.all(jobs);
      await queue;
      return out;
    },
    async finish() {
      const out = [];
      speech.push(...quiet);
      speechCount += count(quiet);
      quiet = [];
      const job = speech.length ? decode(out) : null;
      await job;
      await queue;
      return out;
    }
  };
}

module.exports = { createUtteranceSegmenter };
