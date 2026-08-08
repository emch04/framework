const { AppError } = require('@astratra/core');
const parseArgs = require('./args');
const { loadConfig } = require('./config');
const { runAuditSecrets } = require('./commands/auditSecrets');
const { runAuditRoutes } = require('./commands/auditRoutes');
const { runAuditI18n } = require('./commands/auditI18n');
const { runTests } = require('./commands/test');
const { runDeploy } = require('./commands/deploy');

const COMMANDS = {
  'audit:secrets': runAuditSecrets,
  'audit:routes': runAuditRoutes,
  'audit:i18n': runAuditI18n,
  test: runTests,
  deploy: runDeploy
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
  const result = await command(rootDir, config, args);
  process.exitCode = result.exitCode;
  return result;
}

module.exports = {
  COMMANDS,
  runCli
};
