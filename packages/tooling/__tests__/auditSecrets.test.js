const { auditSecrets, runAuditSecrets } = require('../src/commands/auditSecrets');
const { DEFAULT_CONFIG } = require('../src/config');
const { createOutput, createTempProject, writeFile } = require('./helpers');

describe('audit:secrets', () => {
  test('detects literal secrets written to API responses or logs', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'src/controller.js', `
      function handler(req, res) {
        res.json({ apiKey: "abcdefghijklmnop1234" });
      }
    `);

    const result = auditSecrets(rootDir, DEFAULT_CONFIG);

    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: 'src/controller.js',
        line: 3
      })
    ]);
  });

  test('uses configured directories and ignores test files', () => {
    const rootDir = createTempProject();
    const config = {
      ...DEFAULT_CONFIG,
      audit: {
        ...DEFAULT_CONFIG.audit,
        secrets: { dirs: ['app'] }
      }
    };
    writeFile(rootDir, 'src/controller.js', 'console.log({ token: "abcdefghijklmnop1234" });');
    writeFile(rootDir, 'app/controller.test.js', 'console.log({ token: "abcdefghijklmnop1234" });');
    writeFile(rootDir, 'app/controller.js', 'console.log({ token: "abcdefghijklmnop1234" });');

    const result = auditSecrets(rootDir, config);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('app/controller.js');
  });

  test('prints an OK summary when no finding is present', () => {
    const rootDir = createTempProject();
    const output = createOutput();
    writeFile(rootDir, 'src/controller.js', 'res.json({ token: process.env.API_TOKEN });');

    const result = runAuditSecrets(rootDir, DEFAULT_CONFIG, { output });

    expect(result.exitCode).toBe(0);
    expect(output.lines.join('\n')).toContain('aucune fuite');
  });
});
