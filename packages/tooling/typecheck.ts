import {
  COMMANDS,
  DEFAULT_WRITE_CALLS,
  assertFactsAligned,
  assertNoForbiddenTerms,
  assertRoleReadOnly,
  auditRoleWriteSource,
  auditRoleWrites,
  compareFacts,
  extractMatches,
  findForbiddenTerms,
  findForbiddenTermsInFiles,
  formatFactReport,
  formatRoleWriteFindings,
  formatTermReport,
  pickPaths,
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

const roleResult = auditRoleWrites({
  rootDir,
  dirs: ['src'],
  role: ['ROLES.SUPPORT', /'support'/],
  exceptions: [{ match: "'/:id/activate'", reason: 'platform administration', file: 'accounts.routes.js' }],
  writeCalls: DEFAULT_WRITE_CALLS,
  authorListNames: false
});
const firstVia: string[] | undefined = roleResult.findings[0]?.via;
void firstVia;
formatRoleWriteFindings(roleResult);
assertRoleReadOnly({ dirs: ['src'], role: 'ROLES.SUPPORT' });
auditRoleWriteSource("router.post('/x', h);", { role: 'ROLES.SUPPORT' });

const facts = extractMatches('price: "$49"', { pro: /price: "\$(\d+)"/ }, { parse: (raw) => Number(raw) });
const claims = pickPaths({ plans: { pro: { price: 49 } } }, { pro: 'plans.pro.price' });
const factReport = compareFacts({ facts, claims }, { tolerance: 0, arrayOrder: 'strict', requireEveryFact: true });
const aligned: boolean = factReport.ok;
void aligned;
formatFactReport(factReport);
assertFactsAligned({ facts, claims });

const termReport = findForbiddenTerms({ prompt: 'text' }, ['acme', /north/i, { pattern: 'x', reason: 'why' }], {
  allow: ['Acme Pay'],
  required: ['worldwide']
});
formatTermReport(termReport);
assertNoForbiddenTerms('text', ['acme']);
const fileReport = findForbiddenTermsInFiles({ dirs: ['content'], terms: ['acme'] });
const scanned: number = fileReport.fileCount;
void scanned;
