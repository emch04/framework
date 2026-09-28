/**
 * Runs the generated server-side scripts for real, with bash, git and curl,
 * against throw-away repositories and a loopback HTTP server — the same text
 * `ssh host bash -s` would receive. No network beyond 127.0.0.1.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { REMOTE_DEPLOY_SCRIPT, REMOTE_STATUS_SCRIPT, parseMarkers } = require('../src/deploy/remoteScript');
const { runProcess } = require('../src/processRunner');
const { createTempProject, writeFile } = require('./helpers');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', HOME: process.env.HOME
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) {
    writeFile(dir, name, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  git(dir, 'push', '-q', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}

let server;
let port;
let appDirForServer;

beforeAll(async () => {
  // Healthy unless the checked-out version says "broken": a bad release, for real.
  server = http.createServer((req, res) => {
    const version = fs.readFileSync(path.join(appDirForServer, 'version.txt'), 'utf8').trim();
    res.statusCode = version === 'broken' ? 500 : 200;
    res.end(version);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function setup(appDirName = 'app') {
  const base = createTempProject();
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), 'dev');
  const dev = path.join(base, 'dev');
  git(dev, 'checkout', '-q', '-b', 'main');
  const v1 = commit(dev, { 'version.txt': 'v1\n', 'package-lock.json': '{"v":1}\n' }, 'v1');
  const appDir = path.join(base, appDirName);
  git(base, 'clone', '-q', '-b', 'main', path.join(base, 'origin.git'), appDir);
  appDirForServer = appDir;
  const log = path.join(base, 'actions.log');
  fs.writeFileSync(log, '');
  return { base, dev, appDir, v1, log };
}

async function runDeployScript({ appDir, target, log, install, attempts = '1', deps = '(^|/)package-lock\\.json$', remote = 'origin' }) {
  const args = [
    '', appDir, '', target, remote, 'main', deps,
    install || `echo "install $(cat version.txt)" >> '${log}'`,
    `echo "reload $(cat version.txt)" >> '${log}'`,
    `http://127.0.0.1:${port}/health`, attempts, '1', '2', '1'
  ];
  const result = await runProcess('bash', ['-s', '--', ...args], { input: REMOTE_DEPLOY_SCRIPT, env: GIT_ENV, quiet: true });
  return { ...result, markers: parseMarkers(result.stdout), actions: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('remote deploy script, executed', () => {
  test('healthy release: reset to target, reload once, no install when dependencies did not move', async () => {
    const { dev, appDir, v1, log } = setup();
    const v2 = commit(dev, { 'version.txt': 'v2\n' }, 'v2');

    const result = await runDeployScript({ appDir, target: v2, log });

    expect(result.code).toBe(0);
    expect(result.markers).toMatchObject({ prev: v1, deps: 'unchanged', result: 'deployed' });
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(v2);
    expect(result.actions).toEqual(['reload v2']);
  });

  test('changed lockfile: install runs before the reload', async () => {
    const { dev, appDir, log } = setup();
    const v2 = commit(dev, { 'version.txt': 'v2\n', 'package-lock.json': '{"v":2}\n' }, 'v2');
    const result = await runDeployScript({ appDir, target: v2, log });
    expect(result.markers).toMatchObject({ deps: 'changed', result: 'deployed' });
    expect(result.actions).toEqual(['install v2', 'reload v2']);
  });

  test('unhealthy release: rolled back to the previous commit, reloaded, healthy again', async () => {
    const { dev, appDir, v1, log } = setup();
    const v2 = commit(dev, { 'version.txt': 'broken\n' }, 'bad');

    const result = await runDeployScript({ appDir, target: v2, log });

    expect(result.code).toBe(1);
    expect(result.markers.result).toBe('rolled-back');
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(v1);
    expect(result.actions).toEqual(['reload broken', 'reload v1']);
    expect(result.stdout).toContain(`No 200 from http://127.0.0.1:${port}/health (last: 500)`);
  });

  test('failed install: rolled back and the previous dependencies reinstalled (the source script left the new checkout in place)', async () => {
    const { dev, appDir, v1, log } = setup();
    const v2 = commit(dev, { 'version.txt': 'broken\n', 'package-lock.json': '{"v":2}\n' }, 'bad deps');
    const install = `grep -qv broken version.txt && echo "install $(cat version.txt)" >> '${log}'`;

    const result = await runDeployScript({ appDir, target: v2, log, install });

    expect(result.markers.result).toBe('rolled-back');
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(v1);
    expect(result.actions).toEqual(['install v1', 'reload v1']);
  });

  test('rollback that cannot restore health says so', async () => {
    const { dev, appDir, log } = setup();
    commit(dev, { 'version.txt': 'broken\n' }, 'bad');
    const v3 = commit(dev, { 'version.txt': 'broken\n', 'other.txt': 'x' }, 'still bad');
    // make the running version broken too
    git(appDir, 'pull', '-q', 'origin', 'main');
    git(appDir, 'reset', '-q', '--hard', 'HEAD~1');
    const result = await runDeployScript({ appDir, target: v3, log });
    expect(result.markers.result).toBe('rollback-failed');
  });

  test('a target that is not a commit id changes nothing', async () => {
    const { appDir, v1, log } = setup();
    const result = await runDeployScript({ appDir, target: 'main; touch pwned', log });
    expect(result.code).toBe(2);
    expect(result.markers.result).toBe('failed-before-change');
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(v1);
    expect(result.actions).toEqual([]);
  });

  test('fetch failure changes nothing and reloads nothing', async () => {
    const { dev, appDir, v1, log } = setup();
    const v2 = commit(dev, { 'version.txt': 'v2\n' }, 'v2');
    const result = await runDeployScript({ appDir, target: v2, log, remote: 'no-such-remote' });
    expect(result.markers).toMatchObject({ prev: v1, result: 'failed-before-change' });
    expect(result.actions).toEqual([]);
  });

  test('an app directory with spaces and a quote works (values never spliced into commands)', async () => {
    const { dev, appDir, log } = setup("my app's dir");
    const v2 = commit(dev, { 'version.txt': 'v2\n' }, 'v2');
    const result = await runDeployScript({ appDir, target: v2, log });
    expect(result.markers.result).toBe('deployed');
  });
});

describe('remote status script, executed', () => {
  test('reports each internal URL and the last matching backup line', async () => {
    const { base } = setup();
    const backupLog = writeFile(base, 'backup.log', '2026-09-26 03:00 backup sent\n2026-09-27 03:00 backup FAILED\n2026-09-27 03:05 backup sent\n');
    const result = await runProcess('bash', ['-s', '--', '', '', `http://127.0.0.1:${port}/health\nhttp://127.0.0.1:1/health`, '2', backupLog, 'backup sent', '0'], { input: REMOTE_STATUS_SCRIPT, quiet: true });
    const markers = parseMarkers(result.stdout);
    expect(markers.urls).toEqual([
      { status: 200, url: `http://127.0.0.1:${port}/health` },
      { status: 0, url: 'http://127.0.0.1:1/health' }
    ]);
    expect(markers.backup).toBe('2026-09-27 03:05 backup sent');
    expect(markers.pm2).toBeUndefined();
  });
});
