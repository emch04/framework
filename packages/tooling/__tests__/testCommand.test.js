const path = require('path');
const { detectWorkspaces, runTests } = require('../src/commands/test');
const { DEFAULT_CONFIG, mergeConfig } = require('../src/config');
const { createOutput, createTempProject, writeJson } = require('./helpers');

describe('test command', () => {
  test('detects npm workspaces with a test script', () => {
    const rootDir = createTempProject();
    writeJson(rootDir, 'package.json', { workspaces: ['packages/*'] });
    writeJson(rootDir, 'packages/a/package.json', {
      name: '@demo/a',
      scripts: { test: 'jest' }
    });
    writeJson(rootDir, 'packages/b/package.json', {
      name: '@demo/b'
    });

    const workspaces = detectWorkspaces(rootDir, DEFAULT_CONFIG);

    expect(workspaces).toEqual([
      expect.objectContaining({
        name: '@demo/a',
        path: 'packages/a'
      })
    ]);
  });

  test('uses configured workspaces when provided', () => {
    const rootDir = createTempProject();
    const config = mergeConfig(DEFAULT_CONFIG, {
      test: {
        workspaces: [{ name: 'api', path: 'services/api' }]
      }
    });
    writeJson(rootDir, 'services/api/package.json', {
      scripts: { test: 'node test.js' }
    });
    writeJson(rootDir, 'package.json', { workspaces: ['packages/*'] });
    writeJson(rootDir, 'packages/ignored/package.json', {
      name: 'ignored',
      scripts: { test: 'jest' }
    });

    const workspaces = detectWorkspaces(rootDir, config);

    expect(workspaces).toEqual([
      expect.objectContaining({ name: 'api', path: 'services/api' })
    ]);
  });

  test('runs detected workspaces and aggregates failures', async () => {
    const rootDir = createTempProject();
    const output = createOutput();
    writeJson(rootDir, 'package.json', { workspaces: ['packages/*'] });
    writeJson(rootDir, 'packages/pass/package.json', {
      name: 'pass',
      scripts: { test: 'jest' }
    });
    writeJson(rootDir, 'packages/fail/package.json', {
      name: 'fail',
      scripts: { test: 'jest' }
    });
    const calls = [];

    const result = await runTests(rootDir, DEFAULT_CONFIG, {
      output,
      runCommand: async (command, options) => {
        calls.push({ command, cwd: options.cwd });
        options.onLine('sample output');
        return { code: options.cwd.endsWith(path.join('packages', 'fail')) ? 2 : 0 };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('npm test');
    expect(output.lines.join('\n')).toContain('sample output');
  });
});
