import {
  COMMANDS,
  DEFAULT_CONFIG,
  auditI18n,
  auditRouteFile,
  auditRoutes,
  auditSecrets,
  detectWorkspaces,
  expandWorkspacePattern,
  findRouteFiles,
  findSecretLeaks,
  flattenKeys,
  loadConfig,
  mergeConfig,
  printAuditSecrets,
  readCatalogs,
  resolveDeploySteps,
  runAuditI18n,
  runAuditRoutes,
  runAuditSecrets,
  runCli,
  runDeploy,
  runTests
} from '@astratra/tooling';

const rootDir = '.';
const config = mergeConfig(DEFAULT_CONFIG, {
  audit: {
    secrets: { dirs: ['src'] },
    routes: { dirs: ['src'] },
    i18n: { localesDir: 'locales', sourceDirs: ['src'], referenceLocale: 'fr.json' }
  }
});

loadConfig(rootDir);
flattenKeys({ common: { ok: 'OK' } });
readCatalogs(`${rootDir}/locales`);

auditSecrets(rootDir, config, { dir: 'src' });
findSecretLeaks(`${rootDir}/src/index.js`);
printAuditSecrets({ exitCode: 0, findings: [] });
runAuditSecrets(rootDir, config, { output: console });

auditRouteFile(`${rootDir}/src/users.routes.js`, config.audit.routes);
auditRoutes(rootDir, config, { dir: 'src' });
findRouteFiles(`${rootDir}/src`);
runAuditRoutes(rootDir, config, { output: console });

auditI18n(rootDir, config, { dir: '.' });
runAuditI18n(rootDir, config, { output: console });

expandWorkspacePattern(rootDir, 'packages/*');
detectWorkspaces(rootDir, config);
runTests(rootDir, config, {
  runCommand: async (_command, _options) => ({ code: 0 }),
  output: console
});

resolveDeploySteps(config, undefined);
runDeploy(rootDir, config, {
  mode: 'production',
  runCommand: async (_command, _options) => ({ code: 0 }),
  output: console
});

runCli(['test'], { rootDir, config });
const command = COMMANDS.test;
command(rootDir, config, {});
