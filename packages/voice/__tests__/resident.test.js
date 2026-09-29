const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { buildResidentPiperArgs, createResidentPiperPool } = require('../src');

/* A Piper program that answers each JSON line with its file's path, as the real one does. */
function fakePiper({ silent = false } = {}) {
  const started = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.lines = [];
    child.silent = silent;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        child.lines.push(JSON.parse(line));
        if (!child.silent) child.stdout.write(`${JSON.parse(line).output_file}\n`);
      }
    });
    child.kill = () => child.emit('exit', null);
    started.push(child);
    return child;
  };
  return { started, spawn };
}

test('the resident arguments keep the delivery of the command line and read JSON lines', () => {
  const args = buildResidentPiperArgs({ modelPath: '/v/fr.onnx', lengthScale: 1.05, sentenceSilence: 0.45, speaker: 2 });
  expect(args).toEqual(expect.arrayContaining(['-q', '--model', '/v/fr.onnx', '--noise_scale', '0.73', '--noise_w', '0.92', '--length_scale', '1.05', '--sentence_silence', '0.45', '--json-input', '--speaker', '2']));
  expect(() => buildResidentPiperArgs({})).toThrow('modelPath is required');
});
test('Piper stays in memory: one per voice and delivery, each text a line, a dead one replaced', async () => {
  const { started, spawn } = fakePiper();
  const pool = createResidentPiperPool({ spawn, piperPath: 'piper-x' });
  const said = { model: '/voices/fr.onnx', pace: 0.92, pause: 0.35 };
  await pool.say(said, 'Premier texte.', '/work/a.wav');
  await pool.say(said, 'Deuxième texte.', '/work/b.wav');
  expect(started).toHaveLength(1);
  expect(started[0].command).toBe('piper-x');
  expect(started[0].args).toEqual(expect.arrayContaining(['--json-input', '/voices/fr.onnx']));
  expect(started[0].lines.map((line) => line.output_file)).toEqual(['/work/a.wav', '/work/b.wav']);
  expect(started[0].lines[0].text).toBe('Premier texte.');

  await pool.say({ ...said, pace: 1, pause: 0.5 }, 'Réponse.', '/work/c.wav');
  expect(started).toHaveLength(2);

  started[0].silent = true;
  const lost = pool.say(said, 'Perdu.', '/work/d.wav');
  started[0].emit('exit', 1);
  await expect(lost).rejects.toMatchObject({ code: 'PIPER_UNAVAILABLE' });
  await pool.say(said, 'Repris.', '/work/e.wav');
  expect(started).toHaveLength(3);
});
test('a Piper that does not answer is stopped', async () => {
  const { spawn } = fakePiper({ silent: true });
  const pool = createResidentPiperPool({ spawn, partMaxMs: 20 });
  await expect(pool.say({ model: '/voices/fr.onnx', pace: 1, pause: 0.3 }, 'Rien.', '/work/x.wav')).rejects.toThrow('no answer in 20 ms');
  expect(pool.size).toBe(0);
});
test('warming starts every voice at every delivery and cleans up after each word', async () => {
  const { started, spawn } = fakePiper();
  const pool = createResidentPiperPool({ spawn });
  const cleaned = [];
  pool.warm(['/v/fr.onnx', '/v/en.onnx'], [{ pace: 0.92, pause: 0.35 }, { pace: 1, pause: 0.5 }], { text: 'Bonjour.', file: (n) => `/tmp/warm-${n}.wav`, cleanup: async (file) => { cleaned.push(file); } });
  expect(pool.size).toBe(4);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(started.flatMap((child) => child.lines.map((line) => line.text))).toEqual(['Bonjour.', 'Bonjour.', 'Bonjour.', 'Bonjour.']);
  expect(cleaned.sort()).toEqual(['/tmp/warm-1.wav', '/tmp/warm-2.wav', '/tmp/warm-3.wav', '/tmp/warm-4.wav']);
  expect(() => pool.warm(['/v/fr.onnx'], [{ pace: 1, pause: 1 }], {})).toThrow('file is required');
  expect(() => createResidentPiperPool({})).toThrow('spawn is required');
});
