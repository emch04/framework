const { loadConfig, mergeConfig, DEFAULT_CONFIG } = require('../src/config');
const { createTempProject, writeFile, writeJson } = require('./helpers');

describe('tooling config', () => {
  test('loads default config when no project config exists', () => {
    const rootDir = createTempProject();

    expect(loadConfig(rootDir)).toMatchObject({
      audit: {
        secrets: { dirs: ['src'] },
        routes: { dirs: ['src'] }
      },
      deploy: { steps: [] }
    });
  });

  test('merges astratra.config.json with defaults', () => {
    const rootDir = createTempProject();
    writeJson(rootDir, 'astratra.config.json', {
      audit: {
        secrets: { dirs: ['server'] }
      }
    });

    const config = loadConfig(rootDir);

    expect(config.audit.secrets.dirs).toEqual(['server']);
    expect(config.audit.routes.authMiddlewarePatterns).toEqual(DEFAULT_CONFIG.audit.routes.authMiddlewarePatterns);
  });

  test('loads astratra.config.js objects', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'astratra.config.js', 'module.exports = { deploy: { steps: ["npm run build"] } };');

    const config = loadConfig(rootDir);

    expect(config.deploy.steps).toEqual(['npm run build']);
  });

  test('mergeConfig replaces arrays rather than concatenating them', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      audit: {
        routes: {
          authMiddlewarePatterns: ['customAuth']
        }
      }
    });

    expect(config.audit.routes.authMiddlewarePatterns).toEqual(['customAuth']);
  });
});
