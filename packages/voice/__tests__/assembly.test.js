const { EventEmitter } = require('events');
const { VOICE_FILTER, VOICE_FINISH, VOICE_LOUDNESS, buildReadingGraph, createReadingAssembler } = require('../src');

test('the finish and the loudness are the two halves of the one-pass filter', () => {
  expect(`${VOICE_FINISH},${VOICE_LOUDNESS}`).toBe(VOICE_FILTER);
  expect(VOICE_FINISH).not.toContain('loudnorm');
  expect(VOICE_LOUDNESS).toBe('loudnorm=I=-16:TP=-1.5:LRA=11');
});
test('each take is brought to one rate and followed by its silence; a lower voice is pitched without changing its pace', () => {
  const graph = buildReadingGraph([{ pitch: 1, after: 0.75 }, { pitch: 0.95, after: 0.5 }, { after: 0 }], { finish: 'highpass=f=70' });
  expect(graph).toContain('[0:a]aresample=24000,apad=pad_dur=0.75[p0]');
  expect(graph).toContain('[1:a]asetrate=20948,aresample=22050,atempo=1.0526,aresample=24000,apad=pad_dur=0.5[p1]');
  expect(graph).toContain('[2:a]aresample=24000,apad=pad_dur=0[p2]');
  expect(graph).toMatch(/\[p0\]\[p1\]\[p2\]concat=n=3:v=0:a=1,highpass=f=70,loudnorm=I=-16:TP=-1\.5:LRA=11\[voice\]$/);
});
test('a voice already finished is joined without the finish', () => {
  expect(buildReadingGraph([{}])).toMatch(/concat=n=1:v=0:a=1,loudnorm=I=-16:TP=-1\.5:LRA=11\[voice\]$/);
  expect(() => buildReadingGraph([])).toThrow('at least one take');
});

function fakeFfmpeg({ report = '', fail = false } = {}) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {
      process.nextTick(() => {
        calls.push({ command, args });
        if (fail) { child.stderr.emit('data', 'no such filter'); child.emit('close', 1); return; }
        if (args.includes('null')) child.stderr.emit('data', report);
        child.emit('close', 0);
      });
    } };
    child.kill = jest.fn();
    return child;
  };
  return { calls, spawn };
}

test('the loudness is measured over the whole reading, then applied as one steady gain', async () => {
  const report = '[Parsed_loudnorm_0]\n{\n\t"input_i" : "-21.40",\n\t"input_tp" : "-3.12",\n\t"input_lra" : "5.30",\n\t"input_thresh" : "-31.80",\n\t"output_i" : "-16.02",\n\t"target_offset" : "0.02"\n}\n';
  const { calls, spawn } = fakeFfmpeg({ report });
  const assembler = createReadingAssembler({ spawn, ffmpegPath: 'ffmpeg-x' });
  const result = await assembler.assemble({ takes: [{ file: '/w/a.wav', after: 0.3 }, { file: '/w/b.wav' }], output: '/w/speech.m4a', finish: VOICE_FINISH });
  expect(result).toEqual({ output: '/w/speech.m4a' });
  expect(calls.map((call) => call.command)).toEqual(['ffmpeg-x', 'ffmpeg-x']);
  const [measure, apply] = calls.map((call) => call.args);
  expect(measure.slice(measure.indexOf('-i'), measure.indexOf('-i') + 4)).toEqual(['-i', '/w/a.wav', '-i', '/w/b.wav']);
  expect(measure[measure.indexOf('-filter_complex') + 1]).toContain('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json');
  expect(measure.slice(-3)).toEqual(['-f', 'null', '/dev/null']);
  expect(apply[apply.indexOf('-filter_complex') + 1]).toContain('measured_I=-21.4:measured_TP=-3.12:measured_LRA=5.3:measured_thresh=-31.8:offset=0.02:linear=true');
  expect(apply[apply.indexOf('-filter_complex') + 1]).toContain('equalizer=f=160');
  expect(apply).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '64k', '+faststart']));
  expect(apply.at(-1)).toBe('/w/speech.m4a');
});
test('without a measure the one-pass setting stays, and a failing ffmpeg rejects', async () => {
  const { calls, spawn } = fakeFfmpeg();
  await createReadingAssembler({ spawn }).assemble({ takes: [{ file: 'a.wav' }], output: 'o.m4a' });
  expect(calls[1].args[calls[1].args.indexOf('-filter_complex') + 1]).not.toContain('measured_I');
  expect(calls[1].args[calls[1].args.indexOf('-filter_complex') + 1]).not.toContain('equalizer');
  await expect(createReadingAssembler({ spawn: fakeFfmpeg({ fail: true }).spawn }).assemble({ takes: [{ file: 'a.wav' }], output: 'o.m4a' })).rejects.toThrow('exited with code 1: no such filter');
  expect(() => createReadingAssembler({})).toThrow('spawn is required');
});
