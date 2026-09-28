const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  createPm2App, renderPm2Ecosystem, createSystemdUnit, serverPaths, serviceEnv, setupVenvCommand
} = require('../src');

const PY = '/home/app/models-venv/bin/python3';

describe('serverPaths', () => {
  test('point at files shipped in the package', () => {
    const paths = serverPaths();
    for (const key of ['app', 'backends', 'requirements', 'setupScript']) {
      expect(path.isAbsolute(paths[key])).toBe(true);
      expect(fs.existsSync(paths[key])).toBe(true);
    }
  });

  test('every file listed in package.json "files" for the server exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(expect.arrayContaining(['server/app.py', 'server/backends.py', 'server/setup-venv.sh']));
  });
});

describe('serviceEnv', () => {
  test('maps options to MODELS_* variables and forces offline mode', () => {
    expect(serviceEnv({ modelsDir: '/srv/models', port: 5007, enabled: ['embed', 'rerank'], threads: 2, tokenFile: '/etc/models/token', maxRssMb: 5000 })).toEqual({
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', MODELS_DIR: '/srv/models', MODELS_PORT: '5007',
      MODELS_ENABLED: 'embed,rerank', MODELS_THREADS: '2', MODELS_TOKEN_FILE: '/etc/models/token', MODELS_MAX_RSS_MB: '5000'
    });
  });

  test('refuses a token in clear, bad names, relative paths and control characters', () => {
    expect(() => serviceEnv({ env: { MODELS_TOKEN: 'x' } })).toThrow(/tokenFile/);
    expect(() => serviceEnv({ env: { 'bad-name': 'x' } })).toThrow(/invalid/);
    expect(() => serviceEnv({ modelsDir: 'models' })).toThrow(/absolute/);
    expect(() => serviceEnv({ env: { MODELS_X: 'a\nExecStart=/bin/sh' } })).toThrow(/control/);
    expect(() => serviceEnv({ enabled: ['gpu'] })).toThrow(/subset/);
    expect(() => serviceEnv({ port: 70000 })).toThrow(/port/);
  });
});

describe('createPm2App', () => {
  test('one forked process with the venv interpreter and restart settings', () => {
    const app = createPm2App({ python: PY, modelsDir: '/srv/models', maxMemoryRestart: '4G' });
    expect(app).toMatchObject({
      name: 'models', script: serverPaths().app, interpreter: PY, exec_mode: 'fork', instances: 1,
      max_restarts: 5, restart_delay: 5000, max_memory_restart: '4G'
    });
    expect(app.env.MODELS_DIR).toBe('/srv/models');
    expect(app.cwd).toBe(path.dirname(serverPaths().app));
  });

  test('validates its inputs', () => {
    expect(() => createPm2App({})).toThrow(/python/);
    expect(() => createPm2App({ python: PY, name: 'a b' })).toThrow(/name/);
    expect(() => createPm2App({ python: PY, maxMemoryRestart: 'lots' })).toThrow(/maxMemoryRestart/);
  });

  test('renders a loadable ecosystem file', () => {
    const source = renderPm2Ecosystem(createPm2App({ python: PY, name: 'app-models' }));
    const loaded = {};
    new Function('module', source)(loaded);
    expect(loaded.exports.apps[0].name).toBe('app-models');
  });
});

describe('createSystemdUnit', () => {
  const unit = createSystemdUnit({
    python: PY, user: 'models', modelsDir: '/srv/models', tokenFile: '/etc/models/token',
    memoryMax: '6G', memoryHigh: '5G', cpuQuota: '400%', environmentFile: '/etc/models/env'
  });

  test('runs the app with the venv, as a user, with memory and CPU ceilings', () => {
    expect(unit).toContain(`ExecStart=${PY} ${serverPaths().app}`);
    expect(unit).toContain('User=models');
    expect(unit).toContain('MemoryMax=6G');
    expect(unit).toContain('MemoryHigh=5G');
    expect(unit).toContain('CPUQuota=400%');
    expect(unit).toContain('Environment="MODELS_DIR=/srv/models"');
    expect(unit).toContain('EnvironmentFile=/etc/models/env');
    expect(unit).toMatch(/\[Install\]\nWantedBy=multi-user.target/);
  });

  test('passes the token through LoadCredential, never in the unit', () => {
    expect(unit).toContain('LoadCredential=models-token:/etc/models/token');
    expect(unit).toContain('Environment="MODELS_TOKEN_FILE=%d/models-token"');
    expect(unit).not.toContain('Environment="MODELS_TOKEN_FILE=/etc');
  });

  test('is hardened', () => {
    for (const line of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'PrivateTmp=yes', 'CapabilityBoundingSet=',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX']) {
      expect(unit).toContain(line);
    }
  });

  test('quotes paths with spaces and percent signs, refuses injections', () => {
    const quoted = createSystemdUnit({ python: '/opt/my venv/bin/python', user: 'models', env: { MODELS_X: '50%"x' } });
    expect(quoted).toContain('ExecStart="/opt/my venv/bin/python"');
    expect(quoted).toContain('Environment="MODELS_X=50%%\\"x"');
    expect(() => createSystemdUnit({ python: PY, user: 'models', description: 'x\n[Service]' })).toThrow(/control/);
    expect(() => createSystemdUnit({ python: PY, user: 'Root!' })).toThrow(/user/);
    expect(() => createSystemdUnit({ python: PY })).toThrow(/user/);
    expect(() => createSystemdUnit({ python: PY, user: 'models', memoryMax: 'huge' })).toThrow(/memoryMax/);
    expect(() => createSystemdUnit({ python: PY, user: 'models', cpuQuota: '4' })).toThrow(/cpuQuota/);
  });
});

describe('setup-venv.sh', () => {
  test('setupVenvCommand builds the argv', () => {
    expect(setupVenvCommand({ venvDir: '/srv/venv', components: ['onnx'], python: 'python3.12' })).toEqual([
      'bash', serverPaths().setupScript, '--components', 'onnx', '--python', 'python3.12', '/srv/venv'
    ]);
    expect(() => setupVenvCommand({ venvDir: '/srv/venv', components: ['gpu'] })).toThrow(/components/);
    expect(() => setupVenvCommand({ venvDir: 'venv' })).toThrow(/absolute/);
  });

  test('passes bash -n and its pin check on the shipped requirements', () => {
    const script = serverPaths().setupScript;
    execFileSync('bash', ['-n', script]);
    const out = execFileSync('bash', [script, '--check-only'], { encoding: 'utf8' });
    expect(out).toMatch(/pins ok: \d+ packages/);
  });
});
