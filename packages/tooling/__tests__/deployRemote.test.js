const fs = require('fs');
const path = require('path');
const { runRemoteDeploy, runHealth, resolveRemoteConfig } = require('../src/commands/deployRemote');
const { runDeploy } = require('../src/commands/deploy');
const { acquireLock } = require('../src/deploy/lock');
const { findTrackedSecrets } = require('../src/deploy/checks');
const { analysePm2, backupAgeDays, checkHealth } = require('../src/deploy/health');
const { buildRemoteDeployArgs, buildSshInvocation, parseMarkers, pm2ReloadCommand, REMOTE_DEPLOY_SCRIPT } = require('../src/deploy/remoteScript');
const { createOutput, createTempProject } = require('./helpers');
const { createFakeFetch, createFakeRunner, jsonResponse } = require('./fakes');

const SHA = '3f2c1a9b8e7d6c5b4a39281706f5e4d3c2b1a098';
const PREV = '1111111111111111111111111111111111111111';

function remoteConfig(root, overrides = {}) {
  return {
    deploy: {
      remote: {
        host: 'app-vps',
        name: 'Tertius',
        appUser: 'tertius',
        appDir: '/home/tertius/app',
        nodeDir: '/home/tertius/node',
        pm2: { ecosystem: 'deploy/ecosystem.config.cjs' },
        preSteps: [{ name: 'tests serveur', command: 'npm test', cwd: 'apps/server' }],
        lockFile: path.join(root, '.deploy.lock'),
        health: { internal: ['http://127.0.0.1:3100/health', 'http://127.0.0.1:3101/health'], public: ['https://api.example.com/health'], publicIntervalMs: 1 },
        ...overrides
      }
    }
  };
}

function gitWorld({ status = '', branch = 'main', files = ['src/index.js', '.env.example'], remoteHead = SHA, pushCode = 0, sshStdout, sshCode = 0 } = {}) {
  return createFakeRunner((command, args) => {
    if (command === 'git') {
      if (args[0] === 'status') return { stdout: status };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: `${branch}\n` };
      if (args[0] === 'ls-files') return { stdout: files.join('\0') };
      if (args[0] === 'push') return { code: pushCode };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${SHA}\n` };
      if (args[0] === 'ls-remote') return { stdout: `${remoteHead}\trefs/heads/main\n` };
    }
    if (command === 'ssh') {
      return { code: sshCode, stdout: sshStdout === undefined ? `@@astratra prev=${PREV}\n@@astratra deps=changed\nHealthy inside\n@@astratra result=deployed\n` : sshStdout };
    }
    return { code: 0 };
  });
}

function okFetch() {
  return createFakeFetch([['GET https://api.example.com/health', jsonResponse(200, { ok: true })]]);
}

async function deploy(root, runner, extra = {}) {
  const commands = [];
  const result = await runRemoteDeploy(root, extra.config || remoteConfig(root), {
    dryRun: extra.dryRun,
    output: extra.output || createOutput(),
    runProcess: runner,
    runCommand: async (command, options) => { commands.push({ command, cwd: options.cwd }); return { code: extra.stepCode || 0 }; },
    fetch: extra.fetch || okFetch(),
    sleep: async () => {},
    notify: async () => {}
  });
  return { result, commands };
}

describe('remote deploy flow', () => {
  test('clean tree on main: tests, push, remote script, public check — in that order', async () => {
    const root = createTempProject();
    const runner = gitWorld();
    const { result, commands } = await deploy(root, runner);

    expect(result).toMatchObject({ exitCode: 0, target: SHA, previous: PREV, depsChanged: true, stages: ['lock', 'checks', 'preSteps', 'push', 'remote', 'public'] });
    expect(commands).toEqual([{ command: 'npm test', cwd: path.join(root, 'apps/server') }]);
    const order = runner.calls.map((call) => `${call.command} ${call.args[0]}`);
    expect(order.indexOf('git push')).toBeLessThan(order.findIndex((entry) => entry.startsWith('ssh')));
    const ssh = runner.calls.find((call) => call.command === 'ssh');
    expect(ssh.args.slice(0, 9)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'app-vps', 'bash', '-s', '--', 'tertius']);
    expect(ssh.options.input).toBe(REMOTE_DEPLOY_SCRIPT);
    expect(ssh.args).toContain(SHA);
    expect(ssh.args).toContain("'pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save'");
    expect(fs.existsSync(path.join(root, '.deploy.lock'))).toBe(false);
  });

  test('uncommitted changes are refused before anything runs', async () => {
    const root = createTempProject();
    const runner = gitWorld({ status: ' M src/app.js\n?? notes.txt\n' });
    const { result, commands } = await deploy(root, runner);
    expect(result).toMatchObject({ exitCode: 1, stage: 'checks', error: { code: 'DEPLOY_DIRTY_TREE' } });
    expect(result.error.message).toContain('src/app.js');
    expect(commands).toHaveLength(0);
    expect(runner.calls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  test('a tracked secret file is refused', async () => {
    const root = createTempProject();
    const { result } = await deploy(root, gitWorld({ files: ['src/a.js', 'apps/server/.env.production'] }));
    expect(result.error.code).toBe('DEPLOY_SECRET_TRACKED');
    expect(result.error.message).toContain('apps/server/.env.production');
  });

  test('allowTrackedFiles lets a deliberate file through', async () => {
    const root = createTempProject();
    const config = remoteConfig(root, { allowTrackedFiles: ['frontend/.env.production'] });
    const { result } = await deploy(root, gitWorld({ files: ['frontend/.env.production'] }), { config });
    expect(result.exitCode).toBe(0);
  });

  test('another branch is refused: the server would pull main, not this', async () => {
    const root = createTempProject();
    const { result } = await deploy(root, gitWorld({ branch: 'feature/x' }));
    expect(result.error.code).toBe('DEPLOY_WRONG_BRANCH');
  });

  test('failing tests stop before the push', async () => {
    const root = createTempProject();
    const runner = gitWorld();
    const { result } = await deploy(root, runner, { stepCode: 1 });
    expect(result).toMatchObject({ stage: 'preSteps', error: { code: 'DEPLOY_PRESTEP_FAILED' } });
    expect(runner.calls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  test('push refused, or HEAD not on the remote branch, stops before SSH', async () => {
    const root = createTempProject();
    const refused = await deploy(root, gitWorld({ pushCode: 1 }));
    expect(refused.result.error.code).toBe('DEPLOY_PUSH_FAILED');
    const behind = gitWorld({ remoteHead: PREV });
    const notPushed = await deploy(root, behind);
    expect(notPushed.result.error.code).toBe('DEPLOY_TARGET_NOT_PUSHED');
    expect(behind.calls.some((call) => call.command === 'ssh')).toBe(false);
  });

  test.each([
    ['rolled-back', 'DEPLOY_ROLLED_BACK'],
    ['rollback-failed', 'DEPLOY_ROLLBACK_FAILED'],
    ['failed-before-change', 'DEPLOY_REMOTE_FAILED']
  ])('server answer %s becomes %s, previous commit reported', async (answer, code) => {
    const root = createTempProject();
    const { result } = await deploy(root, gitWorld({ sshCode: 1, sshStdout: `@@astratra prev=${PREV}\n@@astratra result=${answer}\n` }));
    expect(result).toMatchObject({ exitCode: 1, stage: 'remote', previous: PREV, error: { code } });
  });

  test('no answer at all (SSH down) is not reported as a rollback', async () => {
    const root = createTempProject();
    const { result } = await deploy(root, gitWorld({ sshCode: 255, sshStdout: '' }));
    expect(result.error.code).toBe('DEPLOY_SSH_FAILED');
    expect(result.error.message).toContain('inconnu');
  });

  test('a success marker with a failed ssh exit remains an unknown server state', async () => {
    const root = createTempProject();
    const { result } = await deploy(root, gitWorld({ sshCode: 255 }));
    expect(result).toMatchObject({ exitCode: 1, stage: 'remote', previous: PREV, error: { code: 'DEPLOY_SSH_FAILED' } });
  });

  test('a project can show its remote marker lines in the terminal', async () => {
    const root = createTempProject();
    const output = createOutput();
    const config = remoteConfig(root, { marker: '@@tertius', showMarkers: true });
    const { result } = await deploy(root, gitWorld({ sshStdout: `@@tertius prev=${PREV}\n@@tertius result=deployed\n` }), { config, output });
    expect(result.exitCode).toBe(0);
    expect(output.lines).toContain(`  @@tertius prev=${PREV}`);
  });

  test('dry run shows the plan without tests, push, ssh, public fetch or lock', async () => {
    const root = createTempProject();
    const runner = gitWorld();
    const fetch = okFetch();
    const { result, commands } = await deploy(root, runner, { dryRun: true, fetch });
    expect(result).toMatchObject({ exitCode: 0, dryRun: true });
    expect(commands).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect(fs.existsSync(path.join(root, '.deploy.lock'))).toBe(false);
  });

  test('public health retried, then reported without claiming a rollback', async () => {
    const root = createTempProject();
    const fetch = createFakeFetch([['GET', jsonResponse(502, {})]]);
    const { result } = await deploy(root, gitWorld(), { fetch });
    expect(result).toMatchObject({ exitCode: 1, stage: 'public', error: { code: 'DEPLOY_PUBLIC_UNHEALTHY' } });
    expect(fetch.calls).toHaveLength(6);
  });

  test('a running deploy holds the lock; a dead one is taken over', async () => {
    const root = createTempProject();
    const lockPath = path.join(root, '.deploy.lock');
    const held = acquireLock(lockPath, { pid: process.ppid });
    const busy = await deploy(root, gitWorld());
    expect(busy.result.error.code).toBe('DEPLOY_LOCKED');
    expect(fs.existsSync(lockPath)).toBe(true);
    held.release();

    acquireLock(lockPath, { pid: 999999999 });
    const taken = await deploy(root, gitWorld());
    expect(taken.result.exitCode).toBe(0);
  });

  test('`astratra deploy --remote` goes through the same flow', async () => {
    const root = createTempProject();
    const result = await runDeploy(root, { deploy: { steps: [], ...remoteConfig(root).deploy } }, {
      remote: true, output: createOutput(), runProcess: gitWorld(), runCommand: async () => ({ code: 0 }), fetch: okFetch(), sleep: async () => {}, notify: async () => {}
    });
    expect(result.exitCode).toBe(0);
  });

  test('incomplete config is reported, not thrown', async () => {
    const result = await runRemoteDeploy(createTempProject(), { deploy: { remote: { host: 'x' } } }, { output: createOutput() });
    expect(result.error.code).toBe('DEPLOY_CONFIG_INVALID');
    expect(() => resolveRemoteConfig('/r', { deploy: { remote: { host: 'x', appDir: '/a' } } })).toThrow(/reloadCommand/);
  });
});

describe('remote deploy building blocks', () => {
  test('secret detection: real secrets caught, templates allowed', () => {
    const files = ['.env', 'apps/server/.env', '.env.local', 'apps/.env.production', '.env.example', 'config/.env.sample', 'keys/AuthKey_X.p8', 'id_ed25519', 'certs/server.pem', 'android/app/release.keystore', 'play-service-account.json', 'src/env.js', 'docs/p8.md'];
    expect(findTrackedSecrets(files)).toEqual(['.env', 'apps/server/.env', '.env.local', 'apps/.env.production', 'keys/AuthKey_X.p8', 'id_ed25519', 'certs/server.pem', 'android/app/release.keystore', 'play-service-account.json']);
  });

  test('remote arguments: positional order, seconds, rollback flag; newlines refused', () => {
    const remote = resolveRemoteConfig('/r', remoteConfig('/r'));
    const args = buildRemoteDeployArgs(remote, SHA);
    expect(args).toEqual([
      'tertius', '/home/tertius/app', '/home/tertius/node', SHA, 'origin', 'main',
      '(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|package\\.json)$', 'npm ci --omit=dev',
      'pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save',
      'http://127.0.0.1:3100/health\nhttp://127.0.0.1:3101/health', '12', '5', '5', '1', '@@astratra'
    ]);
    expect(() => buildRemoteDeployArgs({ ...remote, appDir: '/a\nrm -rf /' }, SHA)).toThrow(expect.objectContaining({ code: 'DEPLOY_CONFIG_INVALID' }));
    expect(() => buildRemoteDeployArgs(remote, 'HEAD; rm')).toThrow(expect.objectContaining({ code: 'DEPLOY_TARGET_INVALID' }));
  });

  test('ssh arguments are quoted for the remote shell; odd hosts refused', () => {
    const invocation = buildSshInvocation({ host: 'vps', args: ["it's", '$(id)', ''] });
    expect(invocation.args).toEqual(['vps', 'bash', '-s', '--', "'it'\\''s'", "'$(id)'", "''"]);
    expect(() => buildSshInvocation({ host: '-oProxyCommand=x' })).toThrow(expect.objectContaining({ code: 'DEPLOY_HOST_INVALID' }));
    expect(() => buildSshInvocation({ host: 'a;b' })).toThrow(expect.objectContaining({ code: 'DEPLOY_HOST_INVALID' }));
  });

  test('pm2 reload command with an optional --only', () => {
    expect(pm2ReloadCommand({ ecosystem: 'eco.cjs', only: ['api', 'ai'] })).toBe('pm2 startOrReload eco.cjs --only api,ai --update-env && pm2 save');
  });

  test('markers parsed; ordinary output ignored', () => {
    expect(parseMarkers('noise\n@@astratra prev=abc\n@@astratra url=200 http://127.0.0.1:1/h\n@@astratra result=deployed\n'))
      .toEqual({ prev: 'abc', result: 'deployed', urls: [{ status: 200, url: 'http://127.0.0.1:1/h' }] });
  });

  test('project marker is used by the remote deploy script and understood locally', () => {
    const remote = resolveRemoteConfig('/r', remoteConfig('/r', { marker: '@@tertius' }));
    expect(buildRemoteDeployArgs(remote, SHA).at(-1)).toBe('@@tertius');
    expect(parseMarkers('@@tertius prev=abc\n@@tertius result=rolled-back\n', '@@tertius')).toMatchObject({ prev: 'abc', result: 'rolled-back' });
  });
});

describe('health checks', () => {
  test('retries until 200, with the configured pauses', async () => {
    const answers = [503, 0, 200];
    const sleeps = [];
    const fetch = async () => {
      const status = answers.shift();
      if (status === 0) {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return jsonResponse(status, {});
    };
    const result = await checkHealth({ url: 'http://x/health', attempts: 5, intervalMs: 1000, fetch, sleep: async (ms) => sleeps.push(ms) });
    expect(result).toEqual({ ok: true, url: 'http://x/health', attempts: 3, status: 200 });
    expect(sleeps).toEqual([1000, 1000]);
  });

  test('gives the last status after the last attempt, with no pause after it', async () => {
    const sleeps = [];
    const result = await checkHealth({ url: 'u', attempts: 3, fetch: async () => jsonResponse(502, {}), sleep: async (ms) => sleeps.push(ms), intervalMs: 5 });
    expect(result).toMatchObject({ ok: false, attempts: 3, status: 502 });
    expect(sleeps).toHaveLength(2);
  });

  test('pm2 list: stopped and missing processes', () => {
    const jlist = JSON.stringify([
      { name: 'api', pm2_env: { status: 'online' } },
      { name: 'api', pm2_env: { status: 'online' } },
      { name: 'ai', pm2_env: { status: 'errored' } }
    ]);
    expect(analysePm2(jlist, ['api', 'ai', 'worker'])).toEqual({ readable: true, offline: ['ai'], missing: ['worker'], count: 3 });
    expect(analysePm2('not json').readable).toBe(false);
    expect(analysePm2('').readable).toBe(false);
  });

  test('backup age in days from the log line date', () => {
    const now = Date.parse('2026-09-28T09:00:00Z');
    expect(backupAgeDays('2026-09-28 03:00 backup sent', now)).toBe(0);
    expect(backupAgeDays('2026-09-25T03:00 backup sent', now)).toBe(3);
    expect(backupAgeDays('backup sent', now)).toBeNull();
  });

  test('deploy:health gathers public, internal, pm2 and backup into one sentence', async () => {
    const root = createTempProject();
    const config = remoteConfig(root, { status: { pm2Apps: ['api', 'ai'], backupLog: '/home/tertius/backup.log', backupPattern: 'backup sent', backupMaxAgeDays: 1 } });
    const runner = createFakeRunner(() => ({
      stdout: [
        '@@astratra url=200 http://127.0.0.1:3100/health',
        '@@astratra url=000 http://127.0.0.1:3101/health',
        `@@astratra pm2=${JSON.stringify([{ name: 'api', pm2_env: { status: 'online' } }, { name: 'ai', pm2_env: { status: 'stopped' } }])}`,
        '@@astratra backup=2026-09-20 03:00:01 backup sent'
      ].join('\n')
    }));
    const result = await runHealth(root, config, { output: createOutput(), runProcess: runner, fetch: okFetch(), now: () => Date.parse('2026-09-28T09:00:00Z') });
    expect(result.exitCode).toBe(1);
    expect(result.problems).toEqual([
      'http://127.0.0.1:3101/health ne repond pas en interne (code 000)',
      'processus arretes : ai',
      'derniere sauvegarde reussie il y a 8 jours'
    ]);
  });

  test('deploy:health: everything fine, and SSH down', async () => {
    const root = createTempProject();
    const config = remoteConfig(root, { status: { pm2: false } });
    const fine = await runHealth(root, config, { output: createOutput(), runProcess: createFakeRunner(() => ({ stdout: '@@astratra url=200 a\n@@astratra url=200 b' })), fetch: okFetch() });
    expect(fine).toMatchObject({ exitCode: 0, sentence: 'Tout va bien.' });
    const down = await runHealth(root, config, { output: createOutput(), runProcess: createFakeRunner(() => ({ code: 255 })), fetch: okFetch() });
    expect(down.problems).toEqual(['Tertius ne repond pas en SSH']);
  });
});
