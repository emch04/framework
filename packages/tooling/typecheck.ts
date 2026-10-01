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
  runTests,
  ToolingError,
  acquireLock,
  analysePm2,
  applyVersionBump,
  authorizedKeysLine,
  backupAgeDays,
  buildAltoolCommand,
  buildEasBuildArgs,
  buildEasLocalBuildArgs,
  buildRemoteDeployArgs,
  buildSshInvocation,
  checkAscKey,
  checkHealth,
  computeFingerprint,
  createAscToken,
  createGooglePlayClient,
  decideVersionBump,
  findTrackedSecrets,
  generateDispatcherScript,
  loadAscCredentials,
  loadServiceAccount,
  parseMarkers,
  pm2ReloadCommand,
  resolveDispatchAction,
  runDispatchGenerate,
  runEval,
  runHealth,
  runProcess,
  runPublish,
  runPublishFingerprint,
  runRemoteDeploy,
  shellQuote,
  signJwt,
  waitForBuild
} from '@astratra/tooling';
import type { AstratraConfig, DispatchConfig, EvalResult, PublishResult, RemoteDeployConfig } from '@astratra/tooling';

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

/* ---- publishing, remote deploy, dispatcher ---- */

const decision = decideVersionBump({ current: 'a', published: null });
const mustBump: boolean = decision.bump;
void mustBump;
computeFingerprint('.', { compute: async () => ({ hash: 'x' }) });
applyVersionBump('.', 'patch');
buildEasBuildArgs({ platform: 'ios', profile: 'production' });
buildEasLocalBuildArgs({ platform: 'android', output: '/tmp/app.aab' });
waitForBuild({ buildId: 'b', view: async () => ({ status: 'FINISHED', url: 'u', buildNumber: '1', appVersion: null }) });
signJwt({ algorithm: 'ES256', header: { kid: 'K' }, payload: { aud: 'x' }, privateKey: 'pem' });
createAscToken({ keyId: 'ABCDE12345', issuerId: 'uuid', privateKey: 'pem' });
const credentials = loadAscCredentials({ envFile: '~/.appstoreconnect/app.env' });
checkAscKey({ credentials, bundleId: 'com.example.app' });
buildAltoolCommand({ filePath: 'a.ipa', keyId: credentials.keyId, issuerId: credentials.issuerId });
const play = createGooglePlayClient({ packageName: 'com.example.app', serviceAccount: loadServiceAccount({ path: 'sa.json' }) });
play.uploadBundle({ filePath: 'a.aab', track: 'internal', releaseStatus: 'completed' });
runPublish(rootDir, { publish: { projectDir: 'mobile', android: { packageName: 'com.example.app' } } }, { target: 'all' })
  .then((published: PublishResult) => published.results.map((entry) => entry.platform));
runPublishFingerprint(rootDir, {}, { record: true });

const remote: RemoteDeployConfig = {
  host: 'vps',
  appDir: '/srv/app',
  pm2: { ecosystem: 'ecosystem.config.cjs', only: ['api'] },
  health: { internal: ['http://127.0.0.1:3000/health'], public: ['https://example.com/health'] }
};
runRemoteDeploy(rootDir, { deploy: { steps: [], modes: {}, remote } }, { sleep: async () => {} });
runDeploy(rootDir, config, { remote: true });
runHealth(rootDir, { deploy: { steps: [], modes: {}, remote } });
buildRemoteDeployArgs(remote, 'abcdef1');
buildSshInvocation({ host: 'vps', args: ['a'] });
parseMarkers('@@astratra result=deployed').result;
pm2ReloadCommand({ ecosystem: 'eco.cjs' });
checkHealth({ url: 'http://127.0.0.1/health', attempts: 3 });
analysePm2('[]', ['api']);
backupAgeDays('2026-09-28 ok');
findTrackedSecrets(['.env']);
acquireLock('/tmp/x.lock').release();
runProcess('git', ['status'], { quiet: true }).then((result) => result.stdout);
shellQuote("it's");

const dispatch: DispatchConfig = { statusAction: 'etat', actions: [{ name: 'deployer', cwd: '/srv', command: ['npx', 'astratra', 'deploy', '--remote'] }] };
generateDispatcherScript(dispatch);
resolveDispatchAction('deployer', ['deployer']);
authorizedKeysLine({ scriptPath: '/usr/local/bin/actions.sh', publicKey: 'ssh-ed25519 AAAA key' });
runDispatchGenerate(rootDir, { dispatch }, { out: 'actions.sh' });

const failure = new ToolingError('X', 'message', 400);
const failureCode: string = failure.code;
void failureCode;

/* ---- AI evaluation ---- */

runEval(rootDir, { eval: { providers: [{ id: 'openai:chat:local', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LLAMA_API_KEY' }], minPassRate: 0.9 } } as AstratraConfig, { cases: 'evals/cases.json' })
  .then((evaluated: EvalResult) => evaluated.summaries.map((summary) => summary.passRate));
