const { extractFindings, parseNpmAuditJson, severityRank } = require('../src/commands/auditDeps');

// A trimmed but real shape of `npm audit --json` output — modeled on the
// react-router-dom advisory (moderate, open redirect via backslash in
// <Link>/useNavigate) found while auditing a real Astratra consumer project.
const SAMPLE_NPM_AUDIT_JSON = JSON.stringify({
  vulnerabilities: {
    'react-router': {
      name: 'react-router',
      severity: 'moderate',
      isDirect: false,
      range: '6.0.0 - 7.17.0',
      fixAvailable: { name: 'react-router-dom', version: '7.18.2' }
    },
    'react-router-dom': {
      name: 'react-router-dom',
      severity: 'moderate',
      isDirect: true,
      range: '6.0.0-alpha.0 - 7.17.0',
      fixAvailable: { name: 'react-router-dom', version: '7.18.2' }
    },
    'left-pad': {
      name: 'left-pad',
      severity: 'low',
      isDirect: true,
      range: '<1.3.0',
      fixAvailable: true
    }
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 2, high: 0, critical: 0, total: 3 }
  }
});

describe('audit:deps', () => {
  test('severityRank orders npm severities low to critical', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('low'));
    expect(severityRank('low')).toBeLessThan(severityRank('moderate'));
    expect(severityRank('moderate')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  test('parseNpmAuditJson returns null on unparsable output instead of throwing', () => {
    expect(parseNpmAuditJson('not json')).toBeNull();
    expect(parseNpmAuditJson('')).toBeNull();
  });

  test('parseNpmAuditJson parses a real npm audit --json report', () => {
    const report = parseNpmAuditJson(SAMPLE_NPM_AUDIT_JSON);
    expect(report.metadata.vulnerabilities.total).toBe(3);
  });

  test('extractFindings filters by severity threshold and formats fixAvailable', () => {
    const report = parseNpmAuditJson(SAMPLE_NPM_AUDIT_JSON);
    const findings = extractFindings(report, severityRank('moderate'));

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.name).sort()).toEqual(['react-router', 'react-router-dom']);
    expect(findings.find((f) => f.name === 'react-router-dom')).toMatchObject({
      severity: 'moderate',
      isDirect: true,
      fixAvailable: 'react-router-dom@7.18.2'
    });
  });

  test('extractFindings excludes findings below the threshold', () => {
    const report = parseNpmAuditJson(SAMPLE_NPM_AUDIT_JSON);
    const findings = extractFindings(report, severityRank('high'));

    expect(findings).toHaveLength(0);
  });

  test('extractFindings includes low-severity findings when the threshold allows it', () => {
    const report = parseNpmAuditJson(SAMPLE_NPM_AUDIT_JSON);
    const findings = extractFindings(report, severityRank('low'));

    expect(findings).toHaveLength(3);
    expect(findings.find((f) => f.name === 'left-pad')).toMatchObject({ fixAvailable: true });
  });

  test('extractFindings sorts most severe first', () => {
    const report = parseNpmAuditJson(JSON.stringify({
      vulnerabilities: {
        low: { name: 'low', severity: 'low', range: '*' },
        critical: { name: 'critical', severity: 'critical', range: '*' },
        moderate: { name: 'moderate', severity: 'moderate', range: '*' }
      }
    }));
    const findings = extractFindings(report, severityRank('info'));

    expect(findings.map((f) => f.name)).toEqual(['critical', 'moderate', 'low']);
  });

  test('extractFindings returns nothing for a clean report', () => {
    const report = parseNpmAuditJson(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }));
    const findings = extractFindings(report, severityRank('moderate'));

    expect(findings).toHaveLength(0);
  });
});
