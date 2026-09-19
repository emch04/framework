'use strict';

const path = require('path');
const {
  VOICE_VERSION,
  buildFfmpegArgs,
  buildPiperArgs,
  buildVoiceCacheKey,
  mimeTypeForAudio,
  normalizeLanguage
} = require('./builders');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Run a child process through an injected spawn implementation. */
function runProcess(spawn, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args);
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = '';
    let settled = false;
    const clock = options.clock;
    const timer = clock.setTimeout(() => {
      if (typeof child.kill === 'function') child.kill('SIGKILL');
    }, options.timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      callback();
    };
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
    }));
    if (child.stdin) {
      if (options.input !== undefined) child.stdin.write(String(options.input));
      child.stdin.end();
    }
  });
}

function assertAdapter(name, adapter, methods) {
  if (!adapter) throw new Error(`createVoiceService: ${name} is required.`);
  for (const method of methods) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`createVoiceService: ${name}.${method} must be a function.`);
    }
  }
}

function createVoiceService(options = {}) {
  if (typeof options.spawn !== 'function') throw new Error('createVoiceService: spawn is required.');
  assertAdapter('filesystem', options.filesystem, ['readFile', 'rename', 'remove']);
  assertAdapter('cache', options.cache, ['get', 'set']);
  const filesystem = options.filesystem;
  const cache = options.cache;
  const clock = options.clock || { now: () => Date.now(), setTimeout, clearTimeout };
  assertAdapter('clock', clock, ['now', 'setTimeout', 'clearTimeout']);
  const models = options.models || {};
  const defaultLanguage = normalizeLanguage(options.defaultLanguage, 'default');
  const voiceVersion = String(options.voiceVersion || VOICE_VERSION);
  const temporaryDirectory = options.temporaryDirectory || '.';
  const timeoutMs = options.timeoutMs ?? 30000;
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 7 * 24 * 60 * 60;
  const piperPath = options.piperPath || 'piper';
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  let sequence = 0;

  async function safeGet(key) {
    try {
      return await cache.get(key);
    } catch (_error) {
      /* Cache downtime must cost synthesis time, not remove speech entirely. */
      return null;
    }
  }

  async function safeSet(key, entry) {
    try {
      await cache.set(key, entry, cacheTtlSeconds);
    } catch (_error) {
      /* The generated response is still valid when a shared cache is down. */
    }
  }

  async function synthesize(request = {}) {
    const text = String(request.text ?? '').trim();
    if (!text) throw new Error('synthesize: text is required.');
    const requestedLanguage = normalizeLanguage(request.language, defaultLanguage);
    /* A fallback model must also take its own language and speaker. Passing an
       unsupported language's speaker id to the default model can select a
       different speaker or make Piper reject an otherwise valid fallback. */
    const language = models[requestedLanguage] ? requestedLanguage : defaultLanguage;
    const modelPath = models[language];
    if (!modelPath) throw new Error(`synthesize: no model configured for language "${language}".`);
    const cacheKey = buildVoiceCacheKey(text, { language, version: voiceVersion });
    const cached = await safeGet(cacheKey);
    if (cached && cached.audio !== undefined && cached.audio !== null) {
      return { ...cached, audio: Buffer.from(cached.audio), cacheKey, cached: true };
    }

    sequence += 1;
    const base = path.join(temporaryDirectory, `${cacheKey}-${clock.now()}-${sequence}`);
    const wavPath = `${base}.wav`;
    const partialPath = `${base}.part.m4a`;
    const m4aPath = `${base}.m4a`;
    const runOptions = { clock, timeoutMs };
    try {
      await runProcess(options.spawn, piperPath, buildPiperArgs({
        modelPath,
        outputPath: wavPath,
        language,
        speakers: options.speakers,
        ...options.piper
      }), { ...runOptions, input: text });

      let result;
      try {
        await runProcess(options.spawn, ffmpegPath, buildFfmpegArgs(wavPath, partialPath, options.ffmpeg), runOptions);
        /* ffmpeg writes a partial name first. A killed encoder must never
           leave truncated AAC under the final name that a cache accepts. */
        await filesystem.rename(partialPath, m4aPath);
        result = { audio: Buffer.from(await filesystem.readFile(m4aPath)), format: 'm4a', mimeType: mimeTypeForAudio('m4a') };
      } catch (_finishError) {
        await filesystem.remove(partialPath).catch(() => undefined);
        result = { audio: Buffer.from(await filesystem.readFile(wavPath)), format: 'wav', mimeType: mimeTypeForAudio('wav') };
      }
      await safeSet(cacheKey, result);
      return { ...result, audio: Buffer.from(result.audio), cacheKey, cached: false };
    } catch (error) {
      throw new Error(`Voice synthesis failed: ${errorMessage(error)}`);
    } finally {
      await Promise.all([
        filesystem.remove(wavPath).catch(() => undefined),
        filesystem.remove(partialPath).catch(() => undefined),
        filesystem.remove(m4aPath).catch(() => undefined)
      ]);
    }
  }

  return { synthesize, voiceVersion };
}

module.exports = { createVoiceService };
