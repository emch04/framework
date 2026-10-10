'use strict';
// Run manually; mutations affect disposable copies only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const mutations = [
  { name: 'organisation budget bypassed', file: 'governor/mongo.js', from: 'totals.organisation + entry.cost > limits.perOrganisation', to: 'false', test: 'mongo: concurrent budget' },
  { name: 'approval guard bypassed', file: 'governor/mongo.js', from: 'if (guard?.approvals !== undefined)', to: 'if (false)', test: 'mongo: literal payloads' },
  { name: 'record organisation filter removed', file: 'mongo.js', from: "const query = { 'data.organisationId': filter.organisationId, 'data.kind': kind };", to: "const query = { 'data.kind': kind };", test: 'mongo fake: erasing a person' }
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conscience-mongo-mutations-'));
try {
  for (const [index, mutation] of mutations.entries()) {
    const folder = path.join(temp, String(index));
    fs.cpSync(path.join(source, 'src'), path.join(folder, 'src'), { recursive: true });
    fs.cpSync(path.join(source, 'test'), path.join(folder, 'test'), { recursive: true });
    fs.symlinkSync(path.resolve(source, '../../node_modules'), path.join(folder, 'node_modules'), 'dir');
    const file = path.join(folder, 'src', mutation.file), original = fs.readFileSync(file, 'utf8');
    if (!original.includes(mutation.from)) throw new Error(`Mutation no longer applies: ${mutation.name}`);
    fs.writeFileSync(file, original.replace(mutation.from, mutation.to));
    const args = ['--test', `--test-name-pattern=${mutation.test}`, 'test/mongo.test.js'];
    const broken = spawnSync(process.execPath, args, { cwd: folder, encoding: 'utf8', timeout: 30000 });
    if (broken.status === 0 || !/fail\s+1|not ok|✖/.test(broken.stdout)) throw new Error(`Mutation undetected: ${mutation.name}`);
    console.log(`DETECTED: ${mutation.name} -> ${mutation.test}`);
    fs.writeFileSync(file, original);
    const restored = spawnSync(process.execPath, args, { cwd: folder, encoding: 'utf8', timeout: 30000 });
    if (restored.status !== 0) throw new Error(`Restored test failed: ${mutation.name}`);
    console.log(`RESTORED: ${mutation.file} -> test passes`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
