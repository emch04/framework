const { ToolingError } = require('../errors');
const { runProcess } = require('../processRunner');

/**
 * Tracked files that must never reach a server through git. `.env.example`,
 * `.env.sample` and `.env.template` are documentation, not secrets.
 */
const DEFAULT_SECRET_PATTERNS = [
  '(^|/)\\.env$',
  '(^|/)\\.env\\.(?!example$|sample$|template$)[^/]+$',
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)$',
  '\\.p8$',
  '\\.pem$',
  '\\.(p12|pfx|jks|keystore)$',
  '\\.mobileprovision$',
  '(^|/)[^/]*service[-_]?account[^/]*\\.json$'
];

function toRegExp(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern);
}

/** Pure: which of `files` look like secrets, minus the explicitly allowed paths. */
function findTrackedSecrets(files, options = {}) {
  const patterns = (options.patterns || DEFAULT_SECRET_PATTERNS).map(toRegExp);
  const allowed = new Set(options.allow || []);
  return files.filter((file) => file && !allowed.has(file) && patterns.some((pattern) => pattern.test(file)));
}

async function runGit(run, cwd, args) {
  const result = await run('git', args, { cwd, quiet: true });
  if (result.code !== 0) {
    throw new ToolingError('DEPLOY_GIT_FAILED', `git ${args[0]} a echoue (code ${result.code}).`, 500);
  }
  return result.stdout;
}

async function assertCleanTree({ cwd, runProcess: run = runProcess }) {
  const status = await runGit(run, cwd, ['status', '--porcelain']);
  const changed = status.split('\n').filter((line) => line.trim());
  if (changed.length > 0) {
    throw new ToolingError(
      'DEPLOY_DIRTY_TREE',
      `Modifications non commitees (${changed.length}) : seul ce qui est commite part. ${changed.slice(0, 5).map((line) => line.slice(3)).join(', ')}`,
      409
    );
  }
}

async function assertBranch({ cwd, branch, runProcess: run = runProcess }) {
  const current = (await runGit(run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (current !== branch) {
    throw new ToolingError('DEPLOY_WRONG_BRANCH', `Branche ${current} : le deploiement part de ${branch}.`, 409);
  }
}

async function assertNoTrackedSecrets({ cwd, patterns, allow, runProcess: run = runProcess }) {
  const listed = await runGit(run, cwd, ['ls-files', '-z']);
  const found = findTrackedSecrets(listed.split('\0'), { patterns, allow });
  if (found.length > 0) {
    throw new ToolingError(
      'DEPLOY_SECRET_TRACKED',
      `Fichier secret suivi par git : ${found.slice(0, 5).join(', ')}. Le retirer du depot avant de deployer.`,
      409,
      { files: found }
    );
  }
}

module.exports = {
  DEFAULT_SECRET_PATTERNS,
  assertBranch,
  assertCleanTree,
  assertNoTrackedSecrets,
  findTrackedSecrets,
  runGit
};
