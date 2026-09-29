'use strict';

const { VOICE_LOUDNESS, measuredLoudness } = require('./builders');
const { runProcess } = require('./pipeline');

/* A voice that changes its pitch is played at another rate, then brought back
   to its own rate and to time: the pace is kept, only the height moves. Below
   1 the voice is lower. */
function pitchFilter(pitch, sourceRate) {
  return pitch === 1 ? '' : `asetrate=${Math.round(sourceRate * pitch)},aresample=${sourceRate},atempo=${+(1 / pitch).toFixed(4)},`;
}

/**
 * The ffmpeg graph joining the takes of one reading. Each take is brought to
 * its pitch and to one rate, followed by its silence (`after`, in seconds);
 * they follow each other, then the finish (when given) and the loudness.
 * @param {{ pitch?: number, after?: number }[]} takes
 * @param {{ sampleRate?: number, sourceRate?: number, finish?: string | null, loudness?: string }} [options]
 *   `sourceRate`: the rate the takes are pitched at (Piper's, 22 050 Hz)
 */
function buildReadingGraph(takes, { sampleRate = 24000, sourceRate = 22050, finish = null, loudness = VOICE_LOUDNESS } = {}) {
  if (!takes.length) throw new Error('buildReadingGraph: at least one take is required.');
  return [
    ...takes.map(({ pitch = 1, after = 0 }, index) => `[${index}:a]${pitchFilter(pitch, sourceRate)}aresample=${sampleRate},apad=pad_dur=${after}[p${index}]`),
    `${takes.map((_take, index) => `[p${index}]`).join('')}concat=n=${takes.length}:v=0:a=1,${finish ? `${finish},` : ''}${loudness}[voice]`
  ].join(';');
}

/**
 * Assembles the takes of a reading into one finished AAC file. The loudness is
 * set in two passes: in one pass, loudnorm finds its level while it reads and
 * the first seconds come out too loud; the first pass measures the whole
 * reading, the second applies one steady gain (measuredLoudness).
 *
 * @param {{ spawn: import('./index').Spawn, ffmpegPath?: string, clock?: object, timeoutMs?: number,
 *           sampleRate?: number, sourceRate?: number, bitrate?: string }} options
 */
function createReadingAssembler({ spawn, ffmpegPath = 'ffmpeg', clock = { now: () => Date.now(), setTimeout, clearTimeout }, timeoutMs = 120000, sampleRate = 24000, sourceRate = 22050, bitrate = '64k' } = {}) {
  if (typeof spawn !== 'function') throw new Error('createReadingAssembler: spawn is required.');
  return {
    /**
     * @param {{ takes: { file: string, pitch?: number, after?: number }[], output: string, finish?: string | null }} reading
     *   `finish`: the filter chain applied after the takes are joined (none for a voice already finished)
     */
    async assemble({ takes, output, finish = null }) {
      const inputs = takes.flatMap(({ file }) => ['-i', file]);
      const graph = (loudness) => buildReadingGraph(takes, { sampleRate, sourceRate, finish, loudness });
      const run = (args) => runProcess(spawn, ffmpegPath, args, { clock, timeoutMs });
      const measure = await run([
        '-hide_banner', '-nostats', '-y',
        ...inputs,
        '-filter_complex', graph(`${VOICE_LOUDNESS}:print_format=json`),
        '-map', '[voice]',
        '-f', 'null', '/dev/null'
      ]);
      await run([
        '-hide_banner', '-loglevel', 'error', '-y',
        ...inputs,
        '-filter_complex', graph(measuredLoudness(measure)),
        '-map', '[voice]',
        '-ac', '1', '-ar', String(sampleRate),
        '-c:a', 'aac', '-b:a', bitrate,
        '-movflags', '+faststart',
        output
      ]);
      return { output };
    }
  };
}

module.exports = { buildReadingGraph, createReadingAssembler };
