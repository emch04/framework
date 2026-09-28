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

function createEchoGuard({ compare, threshold = 0.75, onFailure, now = Date.now, tailMs = 800, minSamples = 0, windowSamples = 0, passGapMs = 300 } = {}) {
  let forced = false;
  let playbackEnd = -Infinity;
  let held = [];
  let lastPassedAt = -Infinity;
  const active = () => forced || now() < playbackEnd + tailMs;
  async function judge(segment) {
    if (typeof compare !== 'function') return { segment, reason: 'NO_COMPARATOR' };
    const sounding = Float32Array.from(segment.filter((sample) => sample !== 0));
    if (!sounding.length) return { segment, reason: 'NO_SOUND' };
    if (sounding.length < minSamples) return { segment: null, reason: 'TOO_SHORT_TO_COMPARE' };
    try {
      return (await compare(sounding)) >= threshold
        ? { segment: null, reason: 'ECHO_DROPPED' }
        : { segment, reason: 'SPEAKER_PASSED' };
    } catch (error) {
      onFailure?.(error);
      return { segment, reason: 'COMPARATOR_UNAVAILABLE' };
    }
  }
  return {
    setPlaying(value) { forced = Boolean(value); },
    playbackSent(bytes, sampleRate) {
      if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('INVALID_PLAYBACK');
      playbackEnd = Math.max(playbackEnd, now()) + bytes * 1000 / (sampleRate * 2);
    },
    playbackInterrupted() { playbackEnd = Math.min(playbackEnd, now()); forced = false; },
    async inspect(segment) {
      if (!active()) return { segment, reason: 'NO_PLAYBACK' };
      return judge(segment);
    },
    async filter(segment) { return (await this.inspect(segment)).segment; },
    async push(segment) {
      if (!windowSamples) return this.inspect(segment);
      const silent = segment.every((sample) => sample === 0);
      if (silent && held.length) {
        const prior = joinFrames(held);
        held = [];
        const verdict = await judge(prior);
        if (verdict.reason === 'SPEAKER_PASSED') lastPassedAt = now();
        return { segment: verdict.segment ? joinFrames([verdict.segment, segment]) : segment, reason: verdict.reason };
      }
      if (silent) { lastPassedAt = -Infinity; return { segment, reason: 'NO_SOUND' }; }
      if (!active() && !held.length) { lastPassedAt = -Infinity; return { segment, reason: 'NO_PLAYBACK' }; }
      if (active() && now() - lastPassedAt <= passGapMs && segment.some((sample) => sample !== 0)) return { segment, reason: 'SPEAKER_CONTINUES' };
      if (active()) {
        held.push(Float32Array.from(segment));
        const size = held.reduce((sum, part) => sum + part.length, 0);
        if (size < windowSamples) return { segment: null, reason: 'HELD_FOR_COMPARISON' };
      }
      const sound = joinFrames(held);
      held = [];
      const verdict = await judge(sound);
      if (verdict.reason === 'SPEAKER_PASSED') lastPassedAt = now();
      if (!active() && verdict.segment) return { segment: joinFrames([verdict.segment, segment]), reason: verdict.reason };
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
