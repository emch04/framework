const colors = require('../colors');
const { runShellCommand } = require('../processRunner');

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? 0 : index;
}

function parseNpmAuditJson(rawOutput) {
  // `npm audit` exits non-zero the moment it finds anything, but still
  // writes a complete JSON report to stdout either way — the exit code is
  // not a signal that parsing should be skipped.
  try {
    return JSON.parse(rawOutput);
  } catch {
    return null;
  }
}

function extractFindings(report, thresholdRank) {
  const vulnerabilities = (report && report.vulnerabilities) || {};
  const findings = [];

  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (severityRank(entry.severity) < thresholdRank) continue;

    findings.push({
      name,
      severity: entry.severity,
      range: entry.range,
      fixAvailable: entry.fixAvailable
        ? (entry.fixAvailable === true ? true : `${entry.fixAvailable.name}@${entry.fixAvailable.version}`)
        : false,
      isDirect: Boolean(entry.isDirect)
    });
  }

  return findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

async function auditDeps(rootDir, config, options = {}) {
  const threshold = options.severity || config.audit.deps.severityThreshold;
  const thresholdRank = severityRank(threshold);
  const cwd = options.dir ? require('path').resolve(rootDir, options.dir) : rootDir;

  const lines = [];
  await runShellCommand('npm audit --json', {
    cwd,
    onLine: (line) => lines.push(line)
  });

  const report = parseNpmAuditJson(lines.join('\n'));
  if (!report) {
    return {
      exitCode: 1,
      parsed: false,
      findings: [],
      error: 'Impossible de lire la sortie de "npm audit --json" — vérifie que npm est installé et que le projet a un package-lock.json.'
    };
  }

  const findings = extractFindings(report, thresholdRank);

  return {
    exitCode: findings.length > 0 ? 1 : 0,
    parsed: true,
    threshold,
    totalVulnerabilities: (report.metadata && report.metadata.vulnerabilities) || null,
    findings
  };
}

function printAuditDeps(result, output = console) {
  output.log(`${colors.blue('Audit des dépendances — versions avec CVE connue (npm audit)')}\n`);

  if (!result.parsed) {
    output.log(colors.yellow(result.error));
    return;
  }

  for (const finding of result.findings) {
    const severityColor = finding.severity === 'critical' || finding.severity === 'high' ? colors.red : colors.yellow;
    output.log(`${severityColor(finding.severity.toUpperCase())} ${colors.bold(finding.name)} ${colors.dim(finding.range)}`);
    output.log(`  ${finding.isDirect ? 'dépendance directe' : 'dépendance transitive'} — correctif : ${finding.fixAvailable ? colors.green(typeof finding.fixAvailable === 'string' ? finding.fixAvailable : 'disponible') : colors.dim('aucun')}`);
  }

  if (result.findings.length === 0) {
    output.log(colors.green(`OK : aucune vulnérabilité >= ${result.threshold} détectée.`));
  } else {
    output.log(colors.red(`${result.findings.length} paquet(s) vulnérable(s) (seuil : ${result.threshold}).`));
  }
}

async function runAuditDeps(rootDir, config, options = {}) {
  const result = await auditDeps(rootDir, config, options);
  printAuditDeps(result, options.output || console);
  return result;
}

module.exports = {
  auditDeps,
  extractFindings,
  parseNpmAuditJson,
  runAuditDeps,
  severityRank
};
