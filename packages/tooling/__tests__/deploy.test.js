const { resolveDeploySteps, runDeploy } = require('../src/commands/deploy');
const { DEFAULT_CONFIG, mergeConfig } = require('../src/config');
const { createOutput, createTempProject } = require('./helpers');

describe('deploy command', () => {
  test('resolves mode steps by replacing the base sequence', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      deploy: {
        steps: [{ name: 'build', command: 'npm run build' }],
        modes: {
          fast: {
            steps: [{ name: 'healthcheck', command: 'npm run healthcheck' }]
          }
        }
      }
    });

    expect(resolveDeploySteps(config, 'fast')).toEqual([
      { name: 'healthcheck', command: 'npm run healthcheck' }
    ]);
  });

  test('supports mode skip lists', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      deploy: {
        steps: [
          { name: 'build', command: 'npm run build' },
          { name: 'healthcheck', command: 'npm run healthcheck' }
        ],
        modes: {
          fast: { skip: ['healthcheck'] }
        }
      }
    });

    expect(resolveDeploySteps(config, 'fast')).toEqual([
      { name: 'build', command: 'npm run build' }
    ]);
  });

  test('runs deploy steps in order and stops at first failure', async () => {
    const rootDir = createTempProject();
    const output = createOutput();
    const config = mergeConfig(DEFAULT_CONFIG, {
      deploy: {
        steps: [
          { name: 'build', command: 'npm run build' },
          { name: 'healthcheck', command: 'npm run healthcheck' },
          { name: 'after', command: 'npm run after' }
        ]
      }
    });
    const commands = [];

    const result = await runDeploy(rootDir, config, {
      output,
      runCommand: async (command, options) => {
        commands.push(command);
        options.onLine(command);
        return { code: command.includes('healthcheck') ? 1 : 0 };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(commands).toEqual(['npm run build', 'npm run healthcheck']);
    expect(result.results).toHaveLength(2);
    expect(output.lines.join('\n')).toContain('Deploy interrompu');
  });

  test('returns success when no deploy step is configured', async () => {
    const output = createOutput();
    const result = await runDeploy(createTempProject(), DEFAULT_CONFIG, { output });

    expect(result.exitCode).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(output.lines.join('\n')).toContain('Aucune etape');
  });
});
