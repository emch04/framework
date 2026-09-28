/* global fetch */
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const colors = require('../colors');
const { mergeConfig } = require('../config');
const { ToolingError } = require('../errors');
const { runProcess, runShellCommand } = require('../processRunner');
const { acquireLock } = require('../deploy/lock');
const { assertBranch, assertCleanTree, assertNoTrackedSecrets, runGit } = require('../deploy/checks');
const { analysePm2, backupAgeDays, checkHealth } = require('../deploy/health');
const {
  REMOTE_DEPLOY_SCRIPT,
  REMOTE_STATUS_SCRIPT,
  buildRemoteDeployArgs,
  buildSshInvocation,
  parseMarkers,
  pm2ReloadCommand
} = require('../deploy/remoteScript');
const { createDesktopNotifier } = require('../publish/notify');
const { normalizeStep, runSteps } = require('./deploy');

const REMOTE_DEFAULTS = {
  host: null,
  sshOptions: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'],
  appUser: null,
  appDir: null,
  nodeDir: null,
  remote: 'origin',
  branch: 'main',
  requireBranch: true,
  refuseDirty: true,
  push: true,
  secretPatterns: null,
  allowTrackedFiles: [],
  lockFile: null,
  preSteps: [],
  depsPattern: '(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|package\\.json)$',
  installCommand: 'npm ci --omit=dev',
  reloadCommand: null,
  pm2: null,
  rollback: true,
  health: {
    internal: [],
    public: [],
    attempts: 12,
    intervalMs: 5000,
    timeoutMs: 5000,
    publicAttempts: 6,
    publicIntervalMs: 5000,
    publicTimeoutMs: 15000
  },
  status: {
    pm2: true,
    pm2Apps: [],
    backupLog: null,
    backupPattern: null,
    backupMaxAgeDays: 1
  },
  notify: false,
  name: null
};

const RESULT_CODES = {
  'rolled-back': ['DEPLOY_ROLLED_BACK', 'Echec sur le serveur : la version precedente est restauree.'],
  'rollback-failed': ['DEPLOY_ROLLBACK_FAILED', 'Echec sur le serveur ET retour arriere rate : le serveur demande une intervention.'],
  'failed-before-change': ['DEPLOY_REMOTE_FAILED', 'Echec sur le serveur avant tout changement : rien n\'a bouge.'],
  'failed-no-rollback': ['DEPLOY_REMOTE_FAILED', 'Echec sur le serveur, retour arriere desactive : le serveur est dans l\'etat du commit cible.']
};

function resolveRemoteConfig(rootDir, config) {
  const deploy = (config && config.deploy) || {};
  const remote = mergeConfig(REMOTE_DEFAULTS, deploy.remote || {});
  const missing = ['host', 'appDir'].filter((key) => !remote[key]);
  if (missing.length > 0) {
    throw new ToolingError('DEPLOY_CONFIG_INVALID', `deploy.remote incomplet : ${missing.join(', ')}.`, 400);
  }
  if (!remote.reloadCommand) {
    if (!remote.pm2) {
      throw new ToolingError('DEPLOY_CONFIG_INVALID', 'deploy.remote.reloadCommand ou deploy.remote.pm2 est requis.', 400);
    }
    remote.reloadCommand = pm2ReloadCommand(remote.pm2);
  }
  if (!remote.lockFile) {
    const digest = crypto.createHash('sha256').update(path.resolve(rootDir)).digest('hex').slice(0, 12);
    remote.lockFile = path.join(os.tmpdir(), `astratra-deploy-${digest}.lock`);
  } else {
    remote.lockFile = path.resolve(rootDir, remote.lockFile);
  }
  return remote;
}

function remoteName(remote) {
  return remote.name || remote.host;
}

async function runOverSsh(run, remote, script, args, output) {
  const invocation = buildSshInvocation({ host: remote.host, sshOptions: remote.sshOptions, args });
  return run(invocation.command, invocation.args, {
    input: script,
    onLine: (line) => {
      if (!line.startsWith('@@astratra ')) {
        output.log(`  ${line}`);
      }
    }
  });
}

/**
 * The full flow, from this machine:
 *   lock -> clean tree -> right branch -> no tracked secret -> preSteps (tests)
 *   -> git push -> target = HEAD, checked on the remote branch
 *   -> on the server: fetch, reset, install if dependency files moved, reload,
 *      internal health, roll back to the previous commit on any failure
 *   -> public health from here.
 * Nothing is committed. The lock is always released.
 */
async function runRemoteDeploy(rootDir, config, options = {}) {
  const output = options.output || console;
  const run = options.runProcess || runProcess;
  let remote;
  try {
    remote = resolveRemoteConfig(rootDir, config);
  } catch (error) {
    output.log(colors.red(error.message));
    return { exitCode: 1, stage: 'config', error: { code: error.code, message: error.message } };
  }

  const notify = options.notify || createDesktopNotifier({ enabled: remote.notify === true, runProcess: run, platform: options.osPlatform });
  const lockOptions = options.lock || {};
  const stages = [];
  let lock = null;
  let stage = 'lock';
  let target = null;

  output.log(`${colors.blue(`Deploiement distant -> ${remoteName(remote)}`)}\n`);

  try {
    lock = acquireLock(remote.lockFile, lockOptions);
    stages.push('lock');

    stage = 'checks';
    if (remote.refuseDirty !== false) {
      await assertCleanTree({ cwd: rootDir, runProcess: run });
    }
    if (remote.requireBranch !== false) {
      await assertBranch({ cwd: rootDir, branch: remote.branch, runProcess: run });
    }
    await assertNoTrackedSecrets({ cwd: rootDir, patterns: remote.secretPatterns || undefined, allow: remote.allowTrackedFiles, runProcess: run });
    stages.push('checks');

    stage = 'preSteps';
    const steps = (remote.preSteps || []).map(normalizeStep);
    if (steps.length > 0) {
      const results = await runSteps(rootDir, steps, { output, runCommand: options.runCommand || runShellCommand });
      const failed = results.find((result) => result.code !== 0);
      if (failed) {
        throw new ToolingError('DEPLOY_PRESTEP_FAILED', `Etape ${failed.name} en echec : rien n'est parti.`, 409);
      }
    }
    stages.push('preSteps');

    stage = 'push';
    if (remote.push !== false) {
      const pushed = await run('git', ['push', remote.remote, remote.branch], { cwd: rootDir, onLine: (line) => output.log(`  ${line}`) });
      if (pushed.code !== 0) {
        throw new ToolingError('DEPLOY_PUSH_FAILED', `git push ${remote.remote} ${remote.branch} a echoue.`, 502);
      }
    }
    target = (await runGit(run, rootDir, ['rev-parse', 'HEAD'])).trim();
    const published = (await runGit(run, rootDir, ['rev-parse', `${remote.remote}/${remote.branch}`])).trim();
    if (published !== target) {
      throw new ToolingError('DEPLOY_TARGET_NOT_PUSHED', `HEAD (${target.slice(0, 8)}) n'est pas ${remote.remote}/${remote.branch} (${published.slice(0, 8)}) : le serveur ne pourrait pas le recuperer.`, 409);
    }
    stages.push('push');

    stage = 'remote';
    output.log(colors.bold(`Deploiement de ${target.slice(0, 12)} sur ${remoteName(remote)}...`));
    const remoteResult = await runOverSsh(run, remote, REMOTE_DEPLOY_SCRIPT, buildRemoteDeployArgs(remote, target), output);
    const markers = parseMarkers(remoteResult.stdout);
    if (markers.result !== 'deployed') {
      if (!markers.result) {
        throw new ToolingError('DEPLOY_SSH_FAILED', `Connexion ou script distant en echec (code ${remoteResult.code}) : etat du serveur inconnu, verifier a la main.`, 502, { previous: markers.prev || null });
      }
      const [code, message] = RESULT_CODES[markers.result] || ['DEPLOY_REMOTE_FAILED', `Echec sur le serveur (${markers.result}).`];
      throw new ToolingError(code, message, 502, { previous: markers.prev || null, result: markers.result });
    }
    stages.push('remote');

    stage = 'public';
    for (const url of remote.health.public || []) {
      const checked = await checkHealth({
        url,
        attempts: remote.health.publicAttempts,
        intervalMs: remote.health.publicIntervalMs,
        timeoutMs: remote.health.publicTimeoutMs,
        fetch: options.fetch || (typeof fetch === 'function' ? fetch : undefined),
        sleep: options.sleep
      });
      if (!checked.ok) {
        throw new ToolingError(
          'DEPLOY_PUBLIC_UNHEALTHY',
          `${url} ne repond pas 200 (dernier : ${checked.status || checked.error}). Le serveur tourne ${target.slice(0, 12)} et repond en interne : verifier proxy et DNS.`,
          502
        );
      }
      output.log(colors.green(`${url} : 200`));
    }
    stages.push('public');

    output.log(colors.green(`En ligne : ${remoteName(remote)} (${target.slice(0, 12)}).`));
    await notify(`Deploiement ${remoteName(remote)}`, `En ligne (${target.slice(0, 8)}).`);
    return { exitCode: 0, target, previous: markers.prev || null, depsChanged: markers.deps === 'changed', stages };
  } catch (error) {
    output.log(colors.red(error.message));
    await notify(`Deploiement ${remoteName(remote)}`, 'Echec : voir le terminal.');
    return {
      exitCode: 1,
      stage,
      target,
      stages,
      previous: error.details && error.details.previous !== undefined ? error.details.previous : null,
      error: { code: error.code || 'DEPLOY_FAILED', message: error.message }
    };
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

/**
 * `astratra deploy:health` : public URLs from here, then over SSH the internal
 * URLs, the pm2 processes and the age of the last successful backup. One
 * sentence at the end, like the shortcut it replaces.
 */
async function runHealth(rootDir, config, options = {}) {
  const output = options.output || console;
  const run = options.runProcess || runProcess;
  const now = options.now || (() => Date.now());
  let remote;
  try {
    remote = resolveRemoteConfig(rootDir, config);
  } catch (error) {
    output.log(colors.red(error.message));
    return { exitCode: 1, problems: [error.message], error: { code: error.code, message: error.message } };
  }

  const problems = [];
  const checks = { public: [], internal: [], pm2: null, backup: null };

  for (const url of remote.health.public || []) {
    const checked = await checkHealth({
      url,
      attempts: 1,
      timeoutMs: remote.health.publicTimeoutMs,
      fetch: options.fetch || (typeof fetch === 'function' ? fetch : undefined),
      sleep: options.sleep
    });
    checks.public.push(checked);
    if (!checked.ok) {
      problems.push(`${url} ne repond pas (code ${checked.status || '000'})`);
    }
  }

  const status = remote.status || {};
  const statusArgs = [
    remote.appUser || '',
    remote.nodeDir || '',
    (remote.health.internal || []).join('\n'),
    String(Math.max(1, Math.round((remote.health.timeoutMs || 5000) / 1000))),
    status.backupLog || '',
    status.backupPattern || '',
    status.pm2 === false ? '0' : '1'
  ];
  const result = await runOverSsh(run, { ...remote, sshOptions: remote.sshOptions }, REMOTE_STATUS_SCRIPT, statusArgs, { log: () => {} });
  const markers = parseMarkers(result.stdout);

  if (result.code !== 0 && Object.keys(markers).length === 0) {
    problems.push(`${remoteName(remote)} ne repond pas en SSH`);
  } else {
    for (const entry of markers.urls || []) {
      checks.internal.push(entry);
      if (entry.status !== 200) {
        problems.push(`${entry.url} ne repond pas en interne (code ${entry.status || '000'})`);
      }
    }

    if (status.pm2 !== false) {
      checks.pm2 = analysePm2(markers.pm2, status.pm2Apps || []);
      if (!checks.pm2.readable) {
        problems.push('liste pm2 illisible');
      } else {
        if (checks.pm2.offline.length > 0) {
          problems.push(`processus arretes : ${checks.pm2.offline.join(' ')}`);
        }
        if (checks.pm2.missing.length > 0) {
          problems.push(`processus absents : ${checks.pm2.missing.join(' ')}`);
        }
      }
    }

    if (status.backupLog) {
      const age = backupAgeDays(markers.backup, now());
      checks.backup = { line: markers.backup || null, ageDays: age };
      if (age === null) {
        problems.push('aucune sauvegarde reussie dans le journal');
      } else if (age > (status.backupMaxAgeDays === undefined ? 1 : status.backupMaxAgeDays)) {
        problems.push(`derniere sauvegarde reussie il y a ${age} jours`);
      }
    }
  }

  const sentence = problems.length === 0
    ? 'Tout va bien.'
    : `A regarder : ${problems.join('; ')}.`;
  output.log(problems.length === 0 ? colors.green(sentence) : colors.yellow(sentence));
  if (options.notify) {
    await options.notify(`Sante ${remoteName(remote)}`, sentence);
  }

  return { exitCode: problems.length === 0 ? 0 : 1, problems, checks, sentence };
}

module.exports = {
  REMOTE_DEFAULTS,
  resolveRemoteConfig,
  runHealth,
  runRemoteDeploy
};
