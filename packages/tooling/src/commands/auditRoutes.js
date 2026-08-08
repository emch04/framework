const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { DEFAULT_SKIPPED_DIRS, resolveProjectPath, walkFiles } = require('../fsUtils');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function makeRegex(patterns) {
  return new RegExp(patterns.join('|'), 'i');
}

function findRouteFiles(dir) {
  return walkFiles(dir, {
    skippedDirs: DEFAULT_SKIPPED_DIRS,
    include: (name) => name.endsWith('.routes.js')
  });
}

function auditRouteFile(filePath, options) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const findings = [];
  const authMiddleware = makeRegex(options.authMiddlewarePatterns);
  const publicMarkers = makeRegex(options.publicMarkers);
  let globalAuthActive = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/router\.use\s*\(/.test(line) && authMiddleware.test(line)) {
      globalAuthActive = true;
      continue;
    }

    const methodMatch = line.match(new RegExp(`router\\.(${HTTP_METHODS.join('|')})\\s*\\(`));
    if (!methodMatch) {
      continue;
    }

    if (globalAuthActive || authMiddleware.test(line)) {
      continue;
    }

    const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
    if (publicMarkers.test(context)) {
      continue;
    }

    const routeMatch = line.match(/["'`]([^"'`]+)["'`]/);
    findings.push({
      line: i + 1,
      method: methodMatch[1].toUpperCase(),
      route: routeMatch ? routeMatch[1] : '?',
      code: line.trim().slice(0, 120)
    });
  }

  return findings;
}

function getTargetDirs(rootDir, config, options) {
  const dirs = options.dir ? [options.dir] : config.audit.routes.dirs;
  return dirs.map((dir) => resolveProjectPath(rootDir, dir));
}

function auditRoutes(rootDir, config, options = {}) {
  const routeOptions = config.audit.routes;
  const findings = [];
  let fileCount = 0;

  for (const target of getTargetDirs(rootDir, config, options)) {
    for (const filePath of findRouteFiles(target)) {
      fileCount++;
      const fileFindings = auditRouteFile(filePath, routeOptions);

      for (const finding of fileFindings) {
        findings.push({
          file: path.relative(rootDir, filePath),
          ...finding
        });
      }
    }
  }

  return {
    exitCode: findings.length > 0 ? 1 : 0,
    fileCount,
    findings
  };
}

function printAuditRoutes(result, output = console) {
  output.log(`${colors.blue('Audit des permissions de routes - recherche de routes sans auth apparente')}\n`);

  for (const finding of result.findings) {
    output.log(colors.bold(finding.file));
    output.log(`  ${colors.yellow(`${finding.method} ${finding.route}`)} (ligne ${finding.line})`);
    output.log(`     ${colors.dim(finding.code)}`);
  }

  output.log(colors.dim(`${result.fileCount} fichiers de routes analyses`));

  if (result.findings.length === 0) {
    output.log(colors.green('OK : aucune route suspecte detectee.'));
  } else {
    output.log(colors.yellow(`${result.findings.length} route(s) a verifier manuellement - audit heuristique.`));
  }
}

function runAuditRoutes(rootDir, config, options = {}) {
  const result = auditRoutes(rootDir, config, options);
  printAuditRoutes(result, options.output || console);
  return result;
}

module.exports = {
  auditRouteFile,
  auditRoutes,
  findRouteFiles,
  runAuditRoutes
};
