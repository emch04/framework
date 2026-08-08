const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { DEFAULT_SKIPPED_DIRS, resolveProjectPath, walkFiles } = require('../fsUtils');

const SINK = /(?:\b(?:res|response)\.(?:json|send|end)|\b(?:logger|log|console)\.(?:log|info|warn|error|debug))\s*\(/;
const NAMED_LITERAL = /(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["']([A-Za-z0-9_.-]{16,})["']/i;
const PROVIDER_LITERAL = /["'](?:sk_(?:live|test)_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|gh[pous]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})["']/;

function findSecretLeaks(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!SINK.test(line)) {
      return [];
    }

    const matched = NAMED_LITERAL.test(line) || PROVIDER_LITERAL.test(line);

    return matched ? [{ line: index + 1, code: line.trim() }] : [];
  });
}

function getTargetDirs(rootDir, config, options) {
  const dirs = options.dir ? [options.dir] : config.audit.secrets.dirs;
  return dirs.map((dir) => resolveProjectPath(rootDir, dir));
}

function auditSecrets(rootDir, config, options = {}) {
  const findings = [];
  const targets = getTargetDirs(rootDir, config, options);

  for (const target of targets) {
    for (const filePath of walkFiles(target, {
      skippedDirs: DEFAULT_SKIPPED_DIRS,
      include: (name) => /\.(?:js|jsx|ts|tsx)$/.test(name) && !/\.(?:test|spec)\.[jt]sx?$/.test(name)
    })) {
      for (const finding of findSecretLeaks(filePath)) {
        findings.push({
          file: path.relative(rootDir, filePath),
          ...finding
        });
      }
    }
  }

  return {
    exitCode: findings.length > 0 ? 1 : 0,
    findings
  };
}

function printAuditSecrets(result, output = console) {
  output.log(`${colors.blue('Audit des fuites de secrets dans les logs et reponses API')}\n`);

  if (result.findings.length === 0) {
    output.log(colors.green('OK : aucune fuite de secret litteral detectee.'));
    return;
  }

  for (const finding of result.findings) {
    output.log(`${colors.red(`ERREUR ${finding.file}:${finding.line}`)} ${finding.code}`);
  }

  output.log(`\n${colors.red(`${result.findings.length} fuite(s) forte(s) detectee(s).`)}`);
}

function runAuditSecrets(rootDir, config, options = {}) {
  const result = auditSecrets(rootDir, config, options);
  printAuditSecrets(result, options.output || console);
  return result;
}

module.exports = {
  auditSecrets,
  findSecretLeaks,
  printAuditSecrets,
  runAuditSecrets
};
