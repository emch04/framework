const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { readJson } = require('../fsUtils');
const { runShellCommand } = require('../processRunner');

const colorPalette = ['\x1b[35m', '\x1b[33m', '\x1b[36m', '\x1b[34m', '\x1b[32m'];

function expandWorkspacePattern(rootDir, pattern) {
  if (!pattern.includes('*')) {
    return [pattern];
  }

  const beforeStar = pattern.slice(0, pattern.indexOf('*'));
  const afterStar = pattern.slice(pattern.indexOf('*') + 1);
  const baseDir = path.join(rootDir, beforeStar);

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${beforeStar}${entry.name}${afterStar}`)
    .filter((workspacePath) => fs.existsSync(path.join(rootDir, workspacePath, 'package.json')));
}

function normalizeConfiguredWorkspace(workspace) {
  if (typeof workspace === 'string') {
    return { path: workspace };
  }

  return workspace;
}

function detectWorkspaces(rootDir, config) {
  const rootPackagePath = path.join(rootDir, 'package.json');
  const configured = config.test.workspaces;

  let workspaceEntries = configured;
  if (!workspaceEntries) {
    const rootPackage = fs.existsSync(rootPackagePath) ? readJson(rootPackagePath) : {};
    workspaceEntries = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : rootPackage.workspaces && rootPackage.workspaces.packages;
  }

  const expanded = (workspaceEntries || [])
    .map(normalizeConfiguredWorkspace)
    .flatMap((entry) => {
      if (entry.name && entry.path) {
        return [entry];
      }

      return expandWorkspacePattern(rootDir, entry.path).map((workspacePath) => ({
        path: workspacePath,
        name: entry.name
      }));
    });

  return expanded
    .map((workspace, index) => {
      const packageJsonPath = path.join(rootDir, workspace.path, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = readJson(packageJsonPath);
      if (!packageJson.scripts || !packageJson.scripts.test) {
        return null;
      }

      return {
        name: workspace.name || packageJson.name || workspace.path,
        path: workspace.path,
        color: colorPalette[index % colorPalette.length]
      };
    })
    .filter(Boolean);
}

async function runTests(rootDir, config, options = {}) {
  const output = options.output || console;
  const runCommand = options.runCommand || runShellCommand;
  const workspaces = detectWorkspaces(rootDir, config);
  const results = [];
  const startTime = Date.now();

  output.log(`${colors.bold('Lancement des tests des workspaces npm')}\n`);

  for (const workspace of workspaces) {
    const result = await runCommand('npm test', {
      cwd: path.join(rootDir, workspace.path),
      onLine: (line) => output.log(`${workspace.color}[${workspace.name}]\x1b[0m ${line}`)
    });

    results.push({
      name: workspace.name,
      path: workspace.path,
      code: result.code
    });
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const failed = results.filter((result) => result.code !== 0);

  output.log(`\n${colors.bold(`Bilan des tests (${duration}s) :`)}`);
  if (results.length === 0) {
    output.log(colors.yellow('Aucun workspace avec script test detecte.'));
  }

  for (const result of results) {
    if (result.code === 0) {
      output.log(`  ${colors.green(`${result.name} : succes`)}`);
    } else {
      output.log(`  ${colors.red(`${result.name} : echec (code exit ${result.code})`)}`);
    }
  }

  return {
    exitCode: failed.length > 0 ? 1 : 0,
    results,
    workspaces
  };
}

module.exports = {
  detectWorkspaces,
  expandWorkspacePattern,
  runTests
};
