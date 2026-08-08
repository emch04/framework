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
    command: step.command
  };
}

async function runDeploy(rootDir, config, options = {}) {
  const output = options.output || console;
  const runCommand = options.runCommand || runShellCommand;
  const modeName = options.mode;
  const steps = resolveDeploySteps(config, modeName).map(normalizeStep);
  const results = [];

  output.log(`${colors.blue(`Deploy Astratra${modeName ? ` (${modeName})` : ''}`)}\n`);

  if (steps.length === 0) {
    output.log(colors.yellow('Aucune etape de deploy configuree.'));
    return { exitCode: 0, results };
  }

  for (const step of steps) {
    if (!step.command) {
      results.push({ name: step.name, code: 1 });
      output.log(colors.red(`${step.name} : commande manquante`));
      break;
    }

    output.log(colors.bold(`> ${step.name}`));
    const result = await runCommand(step.command, {
      cwd: rootDir,
      onLine: (line) => output.log(`  ${line}`)
    });
    results.push({ name: step.name, command: step.command, code: result.code });

    if (result.code !== 0) {
      output.log(colors.red(`${step.name} : echec (code exit ${result.code})`));
      break;
    }

    output.log(colors.green(`${step.name} : succes`));
  }

  const failed = results.find((result) => result.code !== 0);
  output.log(`\n${colors.bold('Bilan deploy :')}`);
  output.log(failed ? colors.red('Deploy interrompu au premier echec.') : colors.green('Toutes les etapes configurees ont reussi.'));

  return {
    exitCode: failed ? 1 : 0,
    results
  };
}

module.exports = {
  resolveDeploySteps,
  runDeploy
};
