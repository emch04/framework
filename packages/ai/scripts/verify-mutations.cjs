'use strict';

// Each mutation starts from the current file and is restored in finally.
// No git operation is used, and no dependency or model is downloaded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cases = [
  {
    name: 'Quota reservation bypass', file: 'src/managedRouter.js', suite: 'configuredRouter', test: 'enforces rpm margins',
    before: 'if (!(await reserve(stateKey, candidate, cost, callCtx.allowCooling)))', after: 'if (false)'
  },
  {
    name: 'Wrong embedding space accepted', file: 'src/localModels.js', suite: 'localModels', test: 'rejects malformed /vecteurs response',
    before: 'data?.modele !== model || data.dimensions !== dimensions ||', after: 'data.dimensions !== dimensions ||'
  },
  {
    name: 'High risk confirmation bypass', file: 'src/nativeTools.js', suite: 'nativeRisk', test: 'HIGH confirmation waits',
    before: 'return TOOL_RISKS[toolRiskOf(tool)] >= (TOOL_RISKS[threshold] ?? TOOL_RISKS.UNKNOWN);', after: 'return false;'
  }
];
const evidence = [];
for (const mutation of cases) {
  const filename = path.join(root, mutation.file);
  const original = fs.readFileSync(filename, 'utf8');
  if (original.split(mutation.before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation.name}`);
  const resultFile = path.join(root, '.mutation-result.json');
  try {
    fs.writeFileSync(filename, original.replace(mutation.before, mutation.after));
    const run = spawnSync('npm', ['test', '--', '--runInBand', mutation.suite, '--testNamePattern', mutation.test, '--json', '--outputFile', resultFile], {
      cwd: root, env: process.env, encoding: 'utf8'
    });
    const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
    const failures = report?.testResults.flatMap((suite) => suite.assertionResults.filter((test) => test.status === 'failed').map((test) => test.fullName)) || [];
    if (!run.status || !failures.length || report.testResults.some((suite) => /EPERM/.test(suite.message))) {
      throw new Error(`Mutation was not proven by an assertion: ${mutation.name} (exit ${run.status})`);
    }
    evidence.push({ mutation: mutation.name, file: mutation.file, failedTests: failures, failed: report.numFailedTests, passed: report.numPassedTests, exit: run.status, restored: true });
    process.stdout.write(`${mutation.name}: ${failures.join('; ')} FAILED as expected (exit ${run.status}); restored.\n`);
  } finally {
    fs.writeFileSync(filename, original);
    if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  }
}
fs.writeFileSync(path.join(root, 'MUTATION-RESULTS.json'), JSON.stringify({ transport: process.env.AI_TEST_TRANSPORT || 'loopback', mutations: evidence }, null, 2) + '\n');
