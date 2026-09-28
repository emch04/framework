/**
 * Deployment helpers for the model service: pure functions, nothing written,
 * nothing run. They return a pm2 app entry and a systemd unit; the caller
 * decides where they go.
 *
 * Two rules both enforce:
 *   - the token never lands in a generated file (those end up in git): pass a
 *     token FILE, never MODELS_TOKEN;
 *   - ONE process. Every process loads its own copy of the models: a cluster of
 *     four is four times the RAM for no gain on a lock-per-model server.
 */

const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..', 'server');

function serverPaths() {
  return {
    dir: SERVER_DIR,
    app: path.join(SERVER_DIR, 'app.py'),
    backends: path.join(SERVER_DIR, 'backends.py'),
    requirements: path.join(SERVER_DIR, 'requirements.txt'),
    setupScript: path.join(SERVER_DIR, 'setup-venv.sh')
  };
}

const COMPONENTS = ['onnx', 'entities', 'transcribe'];
const MODELS = ['embed', 'rerank', 'nli', 'entities', 'transcribe'];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_ENV = /^MODELS_TOKEN$/;
const OFFLINE_ENV = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };

function fail(message) {
  throw new TypeError(message);
}

/* Newlines or control characters in a value would let it write extra directives. */
function safeValue(value, name) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) fail(`${name}: control characters are not allowed.`);
  return text;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${name}: absolute path expected.`);
  return safeValue(value, name);
}

/** The MODELS_* environment of the service, from friendly options. */
function serviceEnv(options = {}) {
  const env = { ...OFFLINE_ENV };
  if (options.modelsDir !== undefined) env.MODELS_DIR = absolute(options.modelsDir, 'modelsDir');
  if (options.host !== undefined) env.MODELS_HOST = safeValue(options.host, 'host');
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) fail('port: 1 to 65535.');
    env.MODELS_PORT = String(options.port);
  }
  if (options.enabled !== undefined) {
    if (!Array.isArray(options.enabled) || !options.enabled.length || options.enabled.some((m) => !MODELS.includes(m))) {
      fail(`enabled: subset of ${MODELS.join(', ')}.`);
    }
    env.MODELS_ENABLED = options.enabled.join(',');
  }
  if (options.threads !== undefined) {
    if (!Number.isInteger(options.threads) || options.threads < 1) fail('threads: positive integer.');
    env.MODELS_THREADS = String(options.threads);
  }
  if (options.configFile !== undefined) env.MODELS_CONFIG = absolute(options.configFile, 'configFile');
  if (options.tokenFile !== undefined) env.MODELS_TOKEN_FILE = absolute(options.tokenFile, 'tokenFile');
  if (options.maxRssMb !== undefined) {
    if (!Number.isInteger(options.maxRssMb) || options.maxRssMb < 0) fail('maxRssMb: non-negative integer.');
    env.MODELS_MAX_RSS_MB = String(options.maxRssMb);
  }
  for (const [name, value] of Object.entries(options.env || {})) {
    if (!ENV_NAME.test(name)) fail(`env.${name}: invalid variable name.`);
    if (SECRET_ENV.test(name)) fail('env.MODELS_TOKEN: pass tokenFile instead — generated files end up in git.');
    env[name] = safeValue(value, `env.${name}`);
  }
  return env;
}

/**
 * One pm2 app entry for the service.
 * @param {object} options { python (venv interpreter), name?, script?, cwd?, maxMemoryRestart?, ...serviceEnv options }
 */
function createPm2App(options = {}) {
  const python = absolute(options.python, 'python');
  const script = options.script === undefined ? serverPaths().app : absolute(options.script, 'script');
  const name = options.name === undefined ? 'models' : safeValue(options.name, 'name');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail('name: letters, digits, dot, dash, underscore.');
  const app = {
    name,
    script,
    interpreter: python,
    cwd: options.cwd === undefined ? path.dirname(script) : absolute(options.cwd, 'cwd'),
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: options.maxRestarts === undefined ? 5 : options.maxRestarts,
    restart_delay: options.restartDelay === undefined ? 5000 : options.restartDelay,
    /* Loading the models takes seconds; let a stop finish in-flight requests. */
    kill_timeout: options.killTimeout === undefined ? 10000 : options.killTimeout,
    env: serviceEnv(options)
  };
  if (options.maxMemoryRestart !== undefined) {
    const value = String(options.maxMemoryRestart);
    if (!/^\d+[KMG]?$/.test(value)) fail('maxMemoryRestart: e.g. "4G" or "3500M".');
    app.max_memory_restart = value;
  }
  return app;
}

/** An ecosystem file (CommonJS) holding the given pm2 app entries. */
function renderPm2Ecosystem(apps) {
  const list = Array.isArray(apps) ? apps : [apps];
  return `module.exports = ${JSON.stringify({ apps: list }, null, 2)};\n`;
}

/* systemd splits ExecStart on spaces and reads backslashes and quotes: quote when needed. */
function quoteArg(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value.replace(/%/g, '%%');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function quoteEnv(name, value) {
  return `"${name}=${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/**
 * A hardened systemd unit for the service.
 * @param {object} options { python, user, script?, workingDirectory?, group?, description?,
 *   memoryMax?, memoryHigh?, cpuQuota?, restartSec?, environmentFile?, tokenFile?, readWritePaths?, ...serviceEnv options }
 */
function createSystemdUnit(options = {}) {
  const python = absolute(options.python, 'python');
  const script = options.script === undefined ? serverPaths().app : absolute(options.script, 'script');
  const user = safeValue(options.user || '', 'user');
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) fail('user: a system user name is required.');
  const group = options.group === undefined ? null : safeValue(options.group, 'group');
  if (group !== null && !/^[a-z_][a-z0-9_-]*$/.test(group)) fail('group: invalid name.');
  const description = safeValue(options.description || 'Local CPU model service', 'description');
  const workingDirectory = options.workingDirectory === undefined ? path.dirname(script)
    : absolute(options.workingDirectory, 'workingDirectory');
  const size = (value, name) => {
    const text = safeValue(value, name);
    if (!/^\d+[KMGT]?$/.test(text)) fail(`${name}: e.g. "6G".`);
    return text;
  };
  const restartSec = options.restartSec === undefined ? 5 : options.restartSec;
  if (!Number.isInteger(restartSec) || restartSec < 0) fail('restartSec: non-negative integer.');

  /* The token file goes through LoadCredential: readable by this service only, never in the unit. */
  const { tokenFile, ...envOptions } = options;
  const env = serviceEnv(envOptions);
  const lines = [
    '[Unit]',
    `Description=${description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`
  ];
  if (group) lines.push(`Group=${group}`);
  lines.push(`WorkingDirectory=${quoteArg(workingDirectory)}`);
  lines.push(`ExecStart=${quoteArg(python)} ${quoteArg(script)}`);
  if (options.environmentFile !== undefined) lines.push(`EnvironmentFile=${absolute(options.environmentFile, 'environmentFile')}`);
  if (tokenFile !== undefined) {
    lines.push(`LoadCredential=models-token:${absolute(tokenFile, 'tokenFile')}`);
    env.MODELS_TOKEN_FILE = '%d/models-token';
  }
  for (const [name, value] of Object.entries(env)) {
    lines.push(`Environment=${name === 'MODELS_TOKEN_FILE' && value === '%d/models-token'
      ? `"MODELS_TOKEN_FILE=%d/models-token"` : quoteEnv(name, value)}`);
  }
  lines.push(
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    'TimeoutStopSec=15'
  );
  if (options.memoryHigh !== undefined) lines.push(`MemoryHigh=${size(options.memoryHigh, 'memoryHigh')}`);
  if (options.memoryMax !== undefined) lines.push(`MemoryMax=${size(options.memoryMax, 'memoryMax')}`);
  if (options.cpuQuota !== undefined) {
    const quota = safeValue(options.cpuQuota, 'cpuQuota');
    if (!/^\d+%$/.test(quota)) fail('cpuQuota: e.g. "400%".');
    lines.push(`CPUQuota=${quota}`);
  }
  lines.push(
    '# Hardening: the service reads models and answers on a socket, nothing more.',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'RestrictNamespaces=yes',
    'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'SystemCallArchitectures=native',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'UMask=0077'
  );
  for (const writable of options.readWritePaths || []) lines.push(`ReadWritePaths=${quoteArg(absolute(writable, 'readWritePaths'))}`);
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

/** argv to create the virtual environment with setup-venv.sh (to hand to execFile). */
function setupVenvCommand(options = {}) {
  const venvDir = absolute(options.venvDir, 'venvDir');
  const components = options.components === undefined ? COMPONENTS : options.components;
  if (!Array.isArray(components) || !components.length || components.some((c) => !COMPONENTS.includes(c))) {
    fail(`components: subset of ${COMPONENTS.join(', ')}.`);
  }
  const argv = ['bash', serverPaths().setupScript, '--components', components.join(',')];
  if (options.python !== undefined) argv.push('--python', safeValue(options.python, 'python'));
  argv.push(venvDir);
  return argv;
}

module.exports = {
  serverPaths,
  serviceEnv,
  createPm2App,
  renderPm2Ecosystem,
  createSystemdUnit,
  setupVenvCommand
};
