const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { runShellCommand } = require('../processRunner');

function resolveDeploySteps(config, modeName) {
  const baseSteps = config.deploy.steps || [];

  if (!modeName) {
    return baseSteps;
  }

  const mode = config.deploy.modes && config.deploy.modes[modeName];
  if (!mode) {
    return baseSteps;
  }

  if (Array.isArray(mode.steps)) {
    return mode.steps;
  }

  const skip = new Set(mode.skip || []);
  return baseSteps.filter((step) => {
    const name = typeof step === 'string' ? step : step.name;
    return !skip.has(name);
  });
}

function normalizeStep(step, index) {
  if (typeof step === 'string') {
    return {
      name: `step-${index + 1}`,
      command: step
    };
  }

  return {
    name: step.name || `step-${index + 1}`,
    command: step.command,
    cwd: step.cwd,
    env: step.env,
    logFile: step.logFile
  };
}

/**
 * Runs shell steps in order and stops at the first failure. A step may name
 * its own `cwd` (relative to rootDir), extra `env`, and a `logFile`: its
 * output then goes to that file (long test runs) and only the path is shown.
 */
async function runSteps(rootDir, steps, options = {}) {
  const output = options.output || console;
  const runCommand = options.runCommand || runShellCommand;
  const results = [];

  for (const step of steps) {
    if (!step.command) {
      results.push({ name: step.name, code: 1 });
      output.log(colors.red(`${step.name} : commande manquante`));
      break;
    }

    output.log(colors.bold(`> ${step.name}`));
    const logPath = step.logFile ? path.resolve(rootDir, step.logFile) : null;
    if (logPath) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, '');
    }

    const result = await runCommand(step.command, {
      cwd: step.cwd ? path.resolve(rootDir, step.cwd) : rootDir,
      env: step.env ? { ...process.env, ...step.env } : undefined,
      onLine: logPath
        ? (line) => fs.appendFileSync(logPath, `${line}\n`)
        : (line) => output.log(`  ${line}`)
    });
    results.push({ name: step.name, command: step.command, code: result.code });

    if (result.code !== 0) {
      output.log(colors.red(`${step.name} : echec (code exit ${result.code})${logPath ? ` : voir ${logPath}` : ''}`));
      break;
    }

    output.log(colors.green(`${step.name} : succes`));
  }

  return results;
}

async function runDeploy(rootDir, config, options = {}) {
  if (options.remote) {
    // Lazy: the remote flow pulls in git/ssh helpers the step runner does not need.
    return require('./deployRemote').runRemoteDeploy(rootDir, config, options);
  }

  const output = options.output || console;
  const modeName = options.mode;
  const steps = resolveDeploySteps(config, modeName).map(normalizeStep);

  output.log(`${colors.blue(`Deploy Astratra${modeName ? ` (${modeName})` : ''}`)}\n`);

  if (steps.length === 0) {
    output.log(colors.yellow('Aucune etape de deploy configuree.'));
    return { exitCode: 0, results: [] };
  }

  const results = await runSteps(rootDir, steps, options);

  const failed = results.find((result) => result.code !== 0);
  output.log(`\n${colors.bold('Bilan deploy :')}`);
  output.log(failed ? colors.red('Deploy interrompu au premier echec.') : colors.green('Toutes les etapes configurees ont reussi.'));

  return {
    exitCode: failed ? 1 : 0,
    results
  };
}

module.exports = {
  normalizeStep,
  resolveDeploySteps,
  runDeploy,
  runSteps
};
