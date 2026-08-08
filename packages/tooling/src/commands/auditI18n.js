const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { lineNumberAt, readJson, resolveProjectPath, walkFiles } = require('../fsUtils');

const STATIC_TRANSLATION_CALL = /\bt\(\s*["']([^"']+)["']/g;

function flattenKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flattenKeys(child, fullKey)
      : [fullKey];
  });
}

function readCatalogs(localesDir) {
  const catalogs = new Map();

  if (!fs.existsSync(localesDir)) {
    return catalogs;
  }

  for (const name of fs.readdirSync(localesDir).sort()) {
    if (!name.endsWith('.json') || name.endsWith('.json.bak')) {
      continue;
    }

    catalogs.set(name, new Set(flattenKeys(readJson(path.join(localesDir, name)))));
  }

  return catalogs;
}

function chooseReferenceLocale(catalogs, configuredReference) {
  if (configuredReference && catalogs.has(configuredReference)) {
    return configuredReference;
  }

  if (catalogs.has('fr.json')) {
    return 'fr.json';
  }

  return catalogs.keys().next().value || null;
}

function auditI18n(rootDir, config, options = {}) {
  const i18nConfig = config.audit.i18n;
  const targetRoot = resolveProjectPath(rootDir, options.dir || '.');
  const localesDir = resolveProjectPath(targetRoot, i18nConfig.localesDir);
  const sourceDirs = i18nConfig.sourceDirs.map((dir) => resolveProjectPath(targetRoot, dir));
  const catalogs = readCatalogs(localesDir);
  const referenceLocale = chooseReferenceLocale(catalogs, i18nConfig.referenceLocale);
  const referenceKeys = referenceLocale ? catalogs.get(referenceLocale) : new Set();
  const findings = [];

  for (const [name, keys] of catalogs) {
    if (name === referenceLocale) {
      continue;
    }

    for (const key of referenceKeys) {
      if (!keys.has(key)) {
        findings.push({ type: 'missing', catalog: name, key, referenceLocale });
      }
    }

    for (const key of keys) {
      if (!referenceKeys.has(key)) {
        findings.push({ type: 'extra', catalog: name, key, referenceLocale });
      }
    }
  }

  const knownKeys = new Set([...catalogs.values()].flatMap((keys) => [...keys]));

  for (const sourceDir of sourceDirs) {
    for (const filePath of walkFiles(sourceDir, {
      include: (name) => /\.(?:js|jsx|ts|tsx)$/.test(name)
    })) {
      const content = fs.readFileSync(filePath, 'utf8');

      for (const match of content.matchAll(STATIC_TRANSLATION_CALL)) {
        if (!knownKeys.has(match[1])) {
          findings.push({
            type: 'unused-key',
            file: path.relative(rootDir, filePath),
            line: lineNumberAt(content, match.index),
            key: match[1]
          });
        }
      }
    }
  }

  return {
    exitCode: findings.length > 0 ? 1 : 0,
    catalogs: [...catalogs.keys()],
    findings,
    referenceLocale
  };
}

function formatFinding(finding) {
  if (finding.type === 'missing') {
    return `${finding.catalog}: cle ${finding.key} absente par rapport a ${finding.referenceLocale}`;
  }

  if (finding.type === 'extra') {
    return `${finding.catalog}: cle ${finding.key} en trop par rapport a ${finding.referenceLocale}`;
  }

  return `${finding.file}:${finding.line}: cle utilisee ${finding.key} absente des catalogues`;
}

function printAuditI18n(result, output = console) {
  output.log(`${colors.blue('Audit de coherence i18n')}\n`);

  if (result.findings.length === 0) {
    output.log(colors.green('OK : aucun ecart statique detecte.'));
    return;
  }

  for (const finding of result.findings) {
    output.log(`${colors.yellow('A verifier')} ${formatFinding(finding)}`);
  }

  output.log(`\n${result.findings.length} ecart(s) a verifier.`);
}

function runAuditI18n(rootDir, config, options = {}) {
  const result = auditI18n(rootDir, config, options);
  printAuditI18n(result, options.output || console);
  return result;
}

module.exports = {
  auditI18n,
  flattenKeys,
  readCatalogs,
  runAuditI18n
};
