'use strict';

function energyClassifier(frame, threshold = 0.02) {
  if (!frame.length) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length) >= threshold ? 1 : 0;
}

function joinFrames(frames) {
  const out = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) { out.set(frame, at); at += frame.length; }
  return out;
}

function createVadSegmenter(options = {}) {
  const classify = options.classify || energyClassifier;
  const threshold = options.threshold ?? 0.5;
  const startFrames = options.startFrames ?? 2;
  const minSpeechFrames = options.minSpeechFrames ?? 1;
  const endFrames = options.endFrames ?? 16;
  const lookbackFrames = options.lookbackFrames ?? 5;
  const maxFrames = options.maxFrames ?? 938;
  const frameSize = options.frameSize;
  if (frameSize !== undefined && (!Number.isInteger(frameSize) || frameSize < 1)) throw new RangeError('INVALID_FRAME_SIZE');
  let active = false; let streak = 0; let quietCount = 0; let voicedCount = 0;
  let frames = []; let before = []; let pending = new Float32Array(0); let classifierFailed = false;

  function emit() {
    const segment = voicedCount >= minSpeechFrames ? joinFrames(frames) : null;
    frames = []; active = false; streak = 0; quietCount = 0; voicedCount = 0;
    return segment?.length ? segment : null;
  }

  async function accept(frame) {
    let score;
    try { score = await (classifierFailed ? energyClassifier(frame) : classify(frame)); }
    catch (error) {
      classifierFailed = true; options.onClassifierFailure?.(error); score = energyClassifier(frame);
    }
    const speaking = Number(score) >= threshold;
    if (!active) {
      before.push(frame);
      if (before.length > lookbackFrames + startFrames) before.shift();
      streak = speaking ? streak + 1 : 0;
      if (streak < startFrames) return [];
      frames = before; before = []; active = true; voicedCount = streak; quietCount = 0;
      options.onSpeechStart?.();
      return [];
    }
    frames.push(frame);
    voicedCount += speaking ? 1 : 0;
    quietCount = speaking ? 0 : quietCount + 1;
    if (quietCount >= endFrames || frames.length >= maxFrames) {
      const atMax = frames.length >= maxFrames && quietCount < endFrames;
      const tail = atMax ? [] : frames.slice(-lookbackFrames);
      const segment = emit();
      before = tail;
      if (atMax) active = true;
      return segment ? [segment] : [];
    }
    return [];
  }

  return {
    async push(input) {
      if (!frameSize) return accept(Float32Array.from(input));
      const joined = joinFrames([pending, Float32Array.from(input)]);
      const out = [];
      let at = 0;
      while (at + frameSize <= joined.length) {
        out.push(...await accept(joined.slice(at, at + frameSize)));
        at += frameSize;
      }
      pending = joined.slice(at);
      return out;
    },
    flush() {
      if (active && pending.length) frames.push(pending);
      pending = new Float32Array(0);
      const segment = active ? emit() : null;
      before = [];
      return segment ? [segment] : [];
    },
    reset() { active = false; streak = 0; quietCount = 0; voicedCount = 0; frames = []; before = []; pending = new Float32Array(0); }
  };
}

/** Continuous speech gate with unchanged timing and silence in rejected frames. */
function createVadSpeechGate({ classify = energyClassifier, frameSize = 512, threshold = 0.5, lookbackFrames = 5, hangFrames = 16, onClassifierFailure } = {}) {
  if (!Number.isInteger(frameSize) || frameSize < 1) throw new RangeError('INVALID_FRAME_SIZE');
  let pending = new Float32Array(0);
  let queue = [];
  let hang = 0;
  let failed = false;
  return {
    async push(input) {
      const arrived = Float32Array.from(input);
      if (failed) return arrived;
      const samples = joinFrames([pending, arrived]);
      const whole = samples.length - (samples.length % frameSize);
      pending = samples.slice(whole);
      const out = [];
      for (let at = 0; at < whole; at += frameSize) {
        const frame = samples.slice(at, at + frameSize);
        let speech;
        try { speech = Number(await classify(frame)) >= threshold; }
        catch (error) {
          failed = true;
          onClassifierFailure?.(error);
          out.push(...queue.map((item) => item.frame), frame, samples.slice(at + frameSize, whole), pending);
          queue = [];
          pending = new Float32Array(0);
          return joinFrames(out);
        }
        if (speech) {
          hang = hangFrames;
          for (const item of queue) item.pass = true;
        }
        queue.push({ frame, pass: speech || hang > 0 });
        if (!speech && hang > 0) hang -= 1;
        while (queue.length > lookbackFrames) {
          const item = queue.shift();
          out.push(item.pass ? item.frame : new Float32Array(item.frame.length));
        }
      }
      return joinFrames(out);
    },
    flush() {
      const out = queue.map((item) => item.pass || failed ? item.frame : new Float32Array(item.frame.length));
      if (pending.length) out.push(pending);
      queue = []; pending = new Float32Array(0);
      return joinFrames(out);
    },
    reset() { pending = new Float32Array(0); queue = []; hang = 0; failed = false; }
  };
}

/* The sound of a stretch: what is left when the runs of exact silence (at least `run` samples, the silence a gate made) are taken out. */
function soundParts(samples, run = 1) {
  const parts = [];
  let start = 0;
  let at = 0;
  while (at < samples.length) {
    if (samples[at] !== 0) { at += 1; continue; }
    let end = at;
    while (end < samples.length && samples[end] === 0) end += 1;
    if (end - at >= run) {
      if (at > start) parts.push(samples.subarray(start, at));
      start = end;
    }
    at = end;
  }
  if (samples.length > start) parts.push(samples.subarray(start));
  return parts;
}

const lengthOf = (parts) => parts.reduce((sum, part) => sum + part.length, 0);

/**
 * Keeps what the speaker played from coming back through the microphone.
 * While playback sounds (and for an echo tail after), sound is compared with
 * the injected `compare` (how much a stretch sounds like the played voice) and
 * dropped when it does; anyone else goes through, so the person can still
 * interrupt.
 *
 * `silentRun`: exact silence shorter than this is part of the sound (1: every
 * zero sample is left out of a comparison). `dropAs: 'silence'` returns what is
 * dropped as silence of the same length, so a stream keeps its timing (the
 * default returns nothing for it). After a comparator failure the guard stops
 * comparing: everything passes, as if it were not there (`latchOnFailure`).
 */
function createEchoGuard({ compare, threshold = 0.75, onFailure, now = Date.now, tailMs = 800, minSamples = 0, windowSamples = 0, passGapMs = 300, silentRun = 1, dropAs = 'nothing', latchOnFailure = true } = {}) {
  let forced = false;
  let playbackEnd = -Infinity;
  /* Chunks held while a window fills, in order: [samples, their sound]. */
  let held = [];
  let heldSound = 0;
  /* A voice judged not the played one goes on being let through while its sound comes without a pause longer than passGapMs. */
  let passing = false;
  let lastPushAt = -Infinity;
  let failed = false;
  const active = () => forced || now() < playbackEnd + tailMs;
  const dropped = (samples) => (dropAs === 'silence' ? new Float32Array(samples.length) : null);
  async function judge(samples, parts) {
    if (typeof compare !== 'function') return { segment: samples, reason: 'NO_COMPARATOR' };
    if (failed) return { segment: samples, reason: 'COMPARATOR_UNAVAILABLE' };
    const length = lengthOf(parts);
    if (!length) return { segment: samples, reason: 'NO_SOUND' };
    if (length < minSamples) return { segment: dropped(samples), reason: 'TOO_SHORT_TO_COMPARE' };
    try {
      return (await compare(joinFrames(parts))) >= threshold
        ? { segment: dropped(samples), reason: 'ECHO_DROPPED' }
        : { segment: samples, reason: 'SPEAKER_PASSED' };
    } catch (error) {
      if (latchOnFailure) failed = true;
      onFailure?.(error);
      return { segment: samples, reason: 'COMPARATOR_UNAVAILABLE' };
    }
  }
  const release = () => {
    const samples = joinFrames(held.map(([chunk]) => chunk));
    const parts = held.flatMap(([, sound]) => sound);
    held = [];
    heldSound = 0;
    return [samples, parts];
  };
  return {
    setPlaying(value) { forced = Boolean(value); },
    playbackSent(bytes, sampleRate) {
      if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('INVALID_PLAYBACK');
      playbackEnd = Math.max(playbackEnd, now()) + bytes * 1000 / (sampleRate * 2);
    },
    playbackInterrupted() { playbackEnd = Math.min(playbackEnd, now()); forced = false; },
    async inspect(segment) {
      if (!active()) return { segment, reason: 'NO_PLAYBACK' };
      return judge(segment, soundParts(segment, silentRun));
    },
    async filter(segment) { return (await this.inspect(segment)).segment; },
    /**
     * A stream, in order, never overlapping: what may go on now (`segment` null
     * while a window fills). Held audio is judged when the window is full, when
     * a silence comes or when playback ends; what came after it follows it.
     */
    async push(segment) {
      if (!windowSamples) return this.inspect(segment);
      const at = now();
      const gap = at - lastPushAt;
      lastPushAt = at;
      if (!segment.length) return { segment, reason: 'NO_SOUND' };
      if (failed) return { segment, reason: 'COMPARATOR_UNAVAILABLE' };
      const sounding = active();
      const silent = segment.every((sample) => sample === 0);
      if (!held.length) {
        if (!sounding || silent) { passing = false; return { segment, reason: silent ? 'NO_SOUND' : 'NO_PLAYBACK' }; }
        if (passing && gap <= passGapMs) return { segment, reason: 'SPEAKER_CONTINUES' };
        passing = false;
      }
      if (held.length && (!sounding || silent)) {
        const [samples, parts] = release();
        const verdict = await judge(samples, parts);
        return { segment: verdict.segment ? joinFrames([verdict.segment, segment]) : segment, reason: verdict.reason };
      }
      const chunk = Float32Array.from(segment);
      const parts = soundParts(chunk, silentRun);
      held.push([chunk, parts]);
      heldSound += lengthOf(parts);
      if (heldSound < windowSamples) return { segment: null, reason: 'HELD_FOR_COMPARISON' };
      const [samples, sound] = release();
      const verdict = await judge(samples, sound);
      passing = verdict.reason === 'SPEAKER_PASSED';
      return verdict;
    }
  };
}

function chainEchoGuards(...guards) {
  const chain = guards.filter(Boolean);
  return {
    async filter(segment) {
      let audio = segment;
      for (const guard of chain) {
        if (audio == null) return null;
        audio = await guard.filter(audio);
      }
      return audio;
    },
    setPlaying(value) { for (const guard of chain) guard.setPlaying?.(value); },
    playbackSent(bytes, sampleRate) { for (const guard of chain) guard.playbackSent?.(bytes, sampleRate); },
    playbackInterrupted() { for (const guard of chain) guard.playbackInterrupted?.(); }
  };
}

module.exports = { energyClassifier, createVadSegmenter, createVadSpeechGate, createEchoGuard, chainEchoGuards };
