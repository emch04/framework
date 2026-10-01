const { AppError } = require('@astratra/core');
const parseArgs = require('./args');
const { loadConfig } = require('./config');
const { runAuditSecrets } = require('./commands/auditSecrets');
const { runAuditRoutes } = require('./commands/auditRoutes');
const { runAuditI18n } = require('./commands/auditI18n');
const { runAuditDeps } = require('./commands/auditDeps');
const { runTests } = require('./commands/test');
const { runDeploy } = require('./commands/deploy');
const { runHealth, runRemoteDeploy } = require('./commands/deployRemote');
const { runPublish, runPublishCheckIos, runPublishFingerprint, runPublishUpload } = require('./commands/publish');
const { runDispatchGenerate } = require('./commands/dispatch');
const { runEval } = require('./commands/evalAi');

const COMMANDS = {
  'audit:secrets': runAuditSecrets,
  'audit:routes': runAuditRoutes,
  'audit:i18n': runAuditI18n,
  'audit:deps': runAuditDeps,
  test: runTests,
  deploy: runDeploy,
  'deploy:remote': runRemoteDeploy,
  'deploy:health': runHealth,
  publish: runPublish,
  'publish:fingerprint': runPublishFingerprint,
  'publish:upload': runPublishUpload,
  'publish:check-ios': runPublishCheckIos,
  'dispatch:generate': runDispatchGenerate,
  eval: runEval
};

async function runCli(argv = [], options = {}) {
  const [commandName, ...rawArgs] = argv;
  const command = COMMANDS[commandName];

  if (!command) {
    throw new AppError(`Commande inconnue: ${commandName || '(vide)'}`, 400);
  }

  const rootDir = options.rootDir || process.cwd();
  const config = options.config || loadConfig(rootDir);
  const args = parseArgs(rawArgs);
  // `astratra publish ios` reads like the scripts it replaces: a bare first word is the target.
  const positional = rawArgs.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 0 && args._target === undefined) {
    args._target = positional[0];
  }
  const result = await command(rootDir, config, args);
  process.exitCode = result.exitCode;
  return result;
}

module.exports = {
  COMMANDS,
  runCli
};
