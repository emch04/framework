const fs = require('fs');
const path = require('path');
const { authorizedKeysLine, generateDispatcherScript, resolveDispatchAction } = require('../src/dispatch/dispatcher');
const { runDispatchGenerate } = require('../src/commands/dispatch');
const { runProcess } = require('../src/processRunner');
const { createOutput, createTempProject, writeFile } = require('./helpers');

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0cG9ydGFibGUta2V5LWZvci10ZXN0cy1vbmx5 iphone-shortcuts';

function setup(extraActions = []) {
  const base = createTempProject();
  const work = path.join(base, 'work dir');
  fs.mkdirSync(work);
  const config = {
    logDir: path.join(base, 'logs'),
    statusAction: 'etat',
    path: ['/usr/bin', '/bin'],
    notify: 'none',
    actions: [
      { name: 'dire-bonjour', cwd: work, command: ['sh', '-c', 'echo "bonjour depuis $(basename "$PWD")"'], background: false, description: 'synchronous' },
      { name: 'fabriquer', cwd: work, command: ['sh', '-c', 'echo built > built.txt; echo fini'] },
      { name: 'longue', cwd: work, command: ['sleep', '5'] },
      { name: 'rate', cwd: path.join(base, 'missing'), command: ['true'] },
      ...extraActions
    ]
  };
  const scriptPath = path.join(base, 'dispatch.sh');
  fs.writeFileSync(scriptPath, generateDispatcherScript(config), { mode: 0o755 });
  return { base, work, config, scriptPath };
}

function invoke(scriptPath, originalCommand, extraEnv = {}) {
  const env = { HOME: process.env.HOME, PATH: '/usr/bin:/bin', ...extraEnv };
  if (originalCommand !== undefined) {
    env.SSH_ORIGINAL_COMMAND = originalCommand;
  }
  return runProcess('/bin/bash', [scriptPath], { env, quiet: true });
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('dispatcher script, executed', () => {
  test('a whitelisted synchronous action runs in its folder and answers', async () => {
    const { scriptPath } = setup();
    const result = await invoke(scriptPath, 'dire-bonjour');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('bonjour depuis work dir');
  });

  test.each([
    ['command separator', 'dire-bonjour; touch PWNED'],
    ['and-chain', 'dire-bonjour && touch PWNED'],
    ['command substitution', 'dire-bonjour$(touch PWNED)'],
    ['backticks', 'dire-bonjour`touch PWNED`'],
    ['space and argument', 'dire-bonjour --evil'],
    ['newline', 'dire-bonjour\ntouch PWNED'],
    ['pipe', 'dire-bonjour|touch PWNED'],
    ['redirection', 'dire-bonjour>PWNED'],
    ['upper case', 'DIRE-BONJOUR'],
    ['path', '../dire-bonjour'],
    ['empty', ''],
    ['too long', `a${'b'.repeat(64)}`]
  ])('%s is refused outright (exit 2), nothing runs', async (_label, raw) => {
    const { scriptPath, work, base } = setup();
    const result = await invoke(scriptPath, raw);
    expect(result.code).toBe(2);
    expect(result.stdout.trim()).toBe('Action refusee.');
    expect(fs.existsSync(path.join(work, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'PWNED'))).toBe(false);
  });

  test('the original script "cleaned" input into a valid name; here a near-miss is refused', async () => {
    const { scriptPath } = setup();
    // tr -cd 'a-z-' would have turned this into "dire-bonjour" and run it.
    const result = await invoke(scriptPath, 'dire-bon$jour');
    expect(result.code).toBe(2);
  });

  test('a well-formed but unknown name lists the actions and exits 1', async () => {
    const { scriptPath } = setup();
    const result = await invoke(scriptPath, 'supprimer-tout');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Action inconnue. Actions : dire-bonjour, fabriquer, longue, rate, etat');
  });

  test('without SSH_ORIGINAL_COMMAND, the first argument is used (local try-out)', async () => {
    const { scriptPath } = setup();
    const result = await runProcess('/bin/bash', [scriptPath, 'dire-bonjour'], { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, quiet: true });
    expect(result.stdout.trim()).toBe('bonjour depuis work dir');
  });

  test('a background action answers at once, logs, releases its lock, and shows in the status', async () => {
    const { scriptPath, work, config } = setup();
    const launched = await invoke(scriptPath, 'fabriquer');
    expect(launched.stdout.trim()).toBe('Lance : fabriquer. Demande « etat » pour suivre.');
    expect(await waitFor(() => fs.existsSync(path.join(work, 'built.txt')) && !fs.existsSync(path.join(config.logDir, 'fabriquer.lock')))).toBe(true);
    const latest = fs.readFileSync(path.join(config.logDir, 'fabriquer.latest.log'), 'utf8');
    expect(latest).toContain('fini');
    expect(latest).toContain('@@ exit=0');
    const status = await invoke(scriptPath, 'etat');
    expect(status.stdout).toContain('── fabriquer (fini)');
    expect(status.stdout).toContain('fini');
  });

  test('the same action never runs twice at once; a dead owner\'s lock is taken over', async () => {
    const { scriptPath, config } = setup();
    const first = await invoke(scriptPath, 'longue');
    expect(first.stdout).toContain('Lance : longue');
    const second = await invoke(scriptPath, 'longue');
    expect(second.stdout.trim()).toBe('Deja en cours : longue. Demande « etat » pour suivre.');
    const status = await invoke(scriptPath, 'etat');
    expect(status.stdout).toContain('── longue (en cours)');

    const lock = path.join(config.logDir, 'longue.lock');
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
    process.kill(pid, 'SIGKILL');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch (_e) { return true; } });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(pid));
    const third = await invoke(scriptPath, 'longue');
    expect(third.stdout).toContain('Lance : longue');
    const newPid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
    expect(newPid).not.toBe(pid);
    process.kill(newPid, 'SIGKILL');
  });

  test('a missing folder fails the action and still frees the lock (the source left it behind)', async () => {
    const { scriptPath, config } = setup();
    await invoke(scriptPath, 'rate');
    expect(await waitFor(() => !fs.existsSync(path.join(config.logDir, 'rate.lock')))).toBe(true);
    expect(fs.readFileSync(path.join(config.logDir, 'rate.latest.log'), 'utf8')).toContain('@@ exit=1');
  });

  test('status with nothing launched', async () => {
    const { scriptPath } = setup();
    expect((await invoke(scriptPath, 'etat')).stdout.trim()).toBe('Aucune action lancee pour l\'instant.');
  });

  test('the generated text passes bash -n and quotes every configured value', async () => {
    const { scriptPath } = setup([{ name: 'bizarre', cwd: "/tmp/it's here", command: ['echo', '$(id)', '`id`', 'a b'], background: false }]);
    const syntax = await runProcess('/bin/bash', ['-n', scriptPath], { quiet: true });
    expect(syntax.code).toBe(0);
    const text = fs.readFileSync(scriptPath, 'utf8');
    expect(text).toContain("bizarre) (cd '/tmp/it'\\''s here' && echo '$(id)' '`id`' 'a b')");
  });
});

describe('dispatcher configuration and key line', () => {
  test('mirror of the name check', () => {
    expect(resolveDispatchAction('etat', ['etat'])).toEqual({ ok: true, action: 'etat' });
    expect(resolveDispatchAction('etat;ls', ['etat'])).toEqual({ ok: false, reason: 'invalid' });
    expect(resolveDispatchAction('autre', ['etat'])).toEqual({ ok: false, reason: 'unknown' });
    expect(resolveDispatchAction(undefined, ['etat'])).toEqual({ ok: false, reason: 'invalid' });
  });

  test('refuses bad names, duplicates, clashes with the status action, multi-line values', () => {
    const base = { actions: [{ name: 'ok', cwd: '/tmp', command: ['true'] }] };
    expect(() => generateDispatcherScript({})).toThrow(expect.objectContaining({ code: 'DISPATCH_CONFIG_INVALID' }));
    expect(() => generateDispatcherScript({ actions: [{ name: 'Bad Name', cwd: '/', command: ['x'] }] })).toThrow(/Nom d'action invalide/);
    expect(() => generateDispatcherScript({ actions: [base.actions[0], base.actions[0]] })).toThrow(/double/);
    expect(() => generateDispatcherScript({ statusAction: 'ok', ...base })).toThrow(/double/);
    expect(() => generateDispatcherScript({ actions: [{ name: 'x', cwd: '/tmp', command: ['echo', 'a\nrm -rf /'] }] })).toThrow(/une ligne/);
    expect(() => generateDispatcherScript({ actions: [{ name: 'x', cwd: '/tmp', command: 'echo hi' }] })).toThrow(/liste/);
  });

  test('~ in paths becomes $HOME, not a literal tilde', () => {
    const text = generateDispatcherScript({ logDir: '~/Library/Logs/remote', path: ['~/.local/bin', '/usr/bin'], actions: [{ name: 'a', cwd: '~/proj', command: ['true'] }] });
    expect(text).toContain('LOG_DIR="$HOME"/Library/Logs/remote');
    expect(text).toContain('PATH="$HOME"/.local/bin:/usr/bin');
    expect(text).toContain('a) launch a "$HOME"/proj true ;;');
  });

  test('authorized_keys line: forced command and every restriction', () => {
    expect(authorizedKeysLine({ scriptPath: '/Users/me/bin/remote-actions.sh', publicKey: PUBLIC_KEY }))
      .toBe(`command="/Users/me/bin/remote-actions.sh",no-port-forwarding,no-pty,no-agent-forwarding,no-X11-forwarding ${PUBLIC_KEY}`);
    expect(authorizedKeysLine({ scriptPath: '/s.sh', publicKey: PUBLIC_KEY, from: '192.168.1.*' })).toMatch(/^command="\/s\.sh",from="192\.168\.1\.\*",no-port-forwarding/);
  });

  test('authorized_keys line: odd script paths, option-laden or broken keys refused', () => {
    expect(() => authorizedKeysLine({ scriptPath: 'relative.sh', publicKey: PUBLIC_KEY })).toThrow(expect.objectContaining({ code: 'DISPATCH_SCRIPT_PATH_INVALID' }));
    expect(() => authorizedKeysLine({ scriptPath: '/a b.sh', publicKey: PUBLIC_KEY })).toThrow(expect.objectContaining({ code: 'DISPATCH_SCRIPT_PATH_INVALID' }));
    expect(() => authorizedKeysLine({ scriptPath: '/a",no-pty.sh', publicKey: PUBLIC_KEY })).toThrow(expect.objectContaining({ code: 'DISPATCH_SCRIPT_PATH_INVALID' }));
    expect(() => authorizedKeysLine({ scriptPath: '/a.sh', publicKey: `command="/bin/sh" ${PUBLIC_KEY}` })).toThrow(expect.objectContaining({ code: 'DISPATCH_PUBLIC_KEY_INVALID' }));
    expect(() => authorizedKeysLine({ scriptPath: '/a.sh', publicKey: `${PUBLIC_KEY}\nssh-rsa AAAA other` })).toThrow(expect.objectContaining({ code: 'DISPATCH_PUBLIC_KEY_INVALID' }));
    expect(() => authorizedKeysLine({ scriptPath: '/a.sh', publicKey: PUBLIC_KEY, from: '*"' })).toThrow(expect.objectContaining({ code: 'DISPATCH_FROM_INVALID' }));
  });

  test('dispatch:generate writes an executable script and prints the key line', async () => {
    const root = createTempProject();
    writeFile(root, 'keys/phone.pub', `${PUBLIC_KEY}\n`);
    const output = createOutput();
    const result = await runDispatchGenerate(root, {
      dispatch: { installPath: '/Users/me/bin/remote-actions.sh', publicKeyFile: 'keys/phone.pub', actions: [{ name: 'deployer', cwd: '/srv/app', command: ['npx', 'astratra', 'deploy', '--remote'] }] }
    }, { out: 'build/remote-actions.sh', output });
    expect(result.exitCode).toBe(0);
    const written = path.join(root, 'build/remote-actions.sh');
    expect(fs.statSync(written).mode & 0o777).toBe(0o755);
    expect(result.authorizedKeysLine).toContain('command="/Users/me/bin/remote-actions.sh"');
    expect(output.lines.join('\n')).toContain(result.authorizedKeysLine);
  });
});
