'use strict';

/* Piper's delivery, shared with the command line (buildPiperArgs): calmer noise; the pace and the pauses are the caller's. */
function buildResidentPiperArgs({ modelPath, lengthScale = 0.92, sentenceSilence = 0.35, noiseScale = 0.73, noiseW = 0.92, speaker } = {}) {
  if (!modelPath) throw new Error('buildResidentPiperArgs: modelPath is required.');
  const args = [
    '-q', '--model', modelPath,
    '--noise_scale', String(noiseScale), '--noise_w', String(noiseW),
    '--length_scale', String(lengthScale), '--sentence_silence', String(sentenceSilence),
    '--json-input'
  ];
  if (speaker !== undefined && speaker !== null && speaker !== '') args.push('--speaker', String(speaker));
  return args;
}

function piperError(message) {
  return Object.assign(new Error(message), { code: 'PIPER_UNAVAILABLE' });
}

/**
 * Pipers kept in memory, one per voice and per delivery (a Piper's pace and
 * pauses are set when it starts; one started for each text spends half a second
 * loading its voice before it says a word). Each one reads its texts one after
 * the other, one JSON line each, and writes back the path of each file once it
 * is written. One that dies or hangs is dropped, and its next text starts a new
 * one.
 *
 * @param {{ spawn: Function, piperPath?: string, partMaxMs?: number, clock?: { setTimeout: Function, clearTimeout: Function },
 *           noiseScale?: number, noiseW?: number }} options
 *   `spawn` follows Node's child_process.spawn (called with piped stdio); `partMaxMs`: a text not
 *   spoken in this time kills its Piper
 */
function createResidentPiperPool({ spawn, piperPath = 'piper', partMaxMs = 60000, clock = { setTimeout, clearTimeout }, noiseScale, noiseW } = {}) {
  if (typeof spawn !== 'function') throw new Error('createResidentPiperPool: spawn is required.');
  const running = new Map();

  function open({ model, pace, pause, speaker }) {
    const name = `${model}\n${pace}\n${pause}\n${speaker ?? ''}`;
    const found = running.get(name);
    if (found) return found;
    const child = spawn(piperPath, buildResidentPiperArgs({ modelPath: model, lengthScale: pace, sentenceSilence: pause, noiseScale, noiseW, speaker }), { stdio: ['pipe', 'pipe', 'pipe'] });
    const one = { child, waiting: [], said: '', errors: '' };
    const fail = (error) => {
      if (running.get(name) === one) running.delete(name);
      for (const job of one.waiting.splice(0)) {
        clock.clearTimeout(job.timer);
        job.reject(error);
      }
    };
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      one.said += chunk;
      let end;
      while ((end = one.said.indexOf('\n')) >= 0) {
        const path = one.said.slice(0, end).trim();
        one.said = one.said.slice(end + 1);
        const index = one.waiting.findIndex((job) => job.file === path);
        if (index < 0) continue;
        const [job] = one.waiting.splice(index, 1);
        clock.clearTimeout(job.timer);
        job.resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      one.errors = (one.errors + chunk).slice(-2000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => fail(piperError(`${piperPath}: ${error.message}`)));
    child.on('exit', (code) => fail(piperError(`${piperPath} exited ${code}: ${one.errors.trim()}`)));
    running.set(name, one);
    return one;
  }

  return {
    /** Speaks `text` into the WAV file `file` with the Piper of this voice and delivery (`{ model, pace, pause, speaker? }`). */
    say(voice, text, file) {
      const one = open(voice);
      return new Promise((resolve, reject) => {
        const job = { file, resolve, reject };
        job.timer = clock.setTimeout(() => {
          reject(piperError(`${piperPath}: no answer in ${partMaxMs} ms`));
          one.child.kill('SIGKILL');
        }, partMaxMs);
        one.waiting.push(job);
        one.child.stdin.write(`${JSON.stringify({ text, output_file: file })}\n`);
      });
    },
    /**
     * Starts every Piper now (each model at each delivery) and has each say one
     * word: a Piper's first text is its slowest, and the first reading must not
     * pay for it. `file(n)` names a scratch file, `cleanup(file)` removes it.
     */
    warm(models, deliveries, { text = 'Hello.', file, cleanup = async () => {} } = {}) {
      if (typeof file !== 'function') throw new Error('warm: file is required.');
      let count = 0;
      for (const model of models) {
        for (const { pace, pause, speaker } of deliveries) {
          const scratch = file((count += 1));
          this.say({ model, pace, pause, speaker }, text, scratch)
            .catch(() => {})
            .finally(() => Promise.resolve(cleanup(scratch)).catch(() => {}));
        }
      }
    },
    /** How many Pipers are in memory. */
    get size() {
      return running.size;
    }
  };
}

module.exports = { buildResidentPiperArgs, createResidentPiperPool };
