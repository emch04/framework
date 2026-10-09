'use strict';
/* Run manually: mutations apply only to disposable copies, never the worktree. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const mutations = [
  { name: 'future information accepted', file: 'replay.js', from: "date(child, key) > cutoff", to: 'false', test: 'future snapshot, nested date' },
  { name: 'real write tool invoked', file: 'sandbox.js', from: "if (tool.kind === 'write') return { simulated: true, intention: true };", to: "if (tool.kind === 'write') { options.tools[name].execute?.(payload); return { simulated: true, intention: true }; }", test: 'sandbox replaces real reads and writes' },
  { name: 'final cases exposed', file: 'holdout.js', from: "Object.hasOwn(object, key) ? object[key] : deny()", to: "Object.hasOwn(object, key) ? object[key] : state.cases", test: 'holdout is unreadable' },
  { name: 'post-execution protocol changes accepted', file: 'laboratory.js', from: "['protocol', 'metrics', 'thresholds', 'hypothesis']", to: "['metrics', 'thresholds', 'hypothesis']", test: 'laboratory preregisters frozen protocol' }
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conscience-p3a-mutations-'));
try {
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index], copy = path.join(temp, String(index));
    fs.mkdirSync(path.join(copy, 'test'), { recursive: true });
    fs.cpSync(path.join(source, 'src'), path.join(copy, 'src'), { recursive: true });
    for (const name of ['experiments.test.js', 'experimentsContract.js', 'helpers.js']) fs.copyFileSync(path.join(source, 'test', name), path.join(copy, 'test', name));
    fs.symlinkSync(path.resolve(source, '../../node_modules'), path.join(copy, 'node_modules'), 'dir');
    const file = path.join(copy, 'src/autoconscience/experiments', mutation.file), original = fs.readFileSync(file, 'utf8');
    if (!original.includes(mutation.from)) throw new Error(`Mutation no longer applies: ${mutation.name}`);
    fs.writeFileSync(file, original.replace(mutation.from, mutation.to));
    const args = ['--test', `--test-name-pattern=${mutation.test}`, 'test/experiments.test.js'];
    const broken = spawnSync(process.execPath, args, { cwd: copy, encoding: 'utf8', timeout: 30000 });
    if (broken.status === 0 || !/fail\s+1|not ok|✖/.test(broken.stdout)) throw new Error(`Test did not detect mutation: ${mutation.name}`);
    console.log(`DETECTED: ${mutation.name} -> ${mutation.test}`);
    fs.writeFileSync(file, original);
    const restored = spawnSync(process.execPath, args, { cwd: copy, encoding: 'utf8', timeout: 30000 });
    if (restored.status !== 0) throw new Error(`Restored test failed: ${mutation.name}`);
    console.log(`RESTORED: ${mutation.file} -> test passes`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
