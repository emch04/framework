const { auditRoutes } = require('../src/commands/auditRoutes');
const { DEFAULT_CONFIG, mergeConfig } = require('../src/config');
const { createTempProject, writeFile } = require('./helpers');

describe('audit:routes', () => {
  test('detects Express routes without apparent auth middleware', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'src/users.routes.js', `
      const router = require('express').Router();
      router.get('/private', listUsers);
      router.post('/safe', requireAuth, createUser);
    `);

    const result = auditRoutes(rootDir, DEFAULT_CONFIG);

    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        method: 'GET',
        route: '/private',
        file: 'src/users.routes.js'
      })
    ]);
  });

  test('respects configured auth middleware patterns', () => {
    const rootDir = createTempProject();
    const config = mergeConfig(DEFAULT_CONFIG, {
      audit: {
        routes: {
          authMiddlewarePatterns: ['tenantGuard']
        }
      }
    });
    writeFile(rootDir, 'src/accounts.routes.js', `
      const router = require('express').Router();
      router.get('/accounts', tenantGuard, listAccounts);
    `);

    const result = auditRoutes(rootDir, config);

    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  test('treats routes after router.use auth as protected and honors public markers', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'src/status.routes.js', `
      const router = require('express').Router();
      // public health endpoint
      router.get('/health', health);
      router.use(requireAuth);
      router.get('/profile', profile);
    `);

    const result = auditRoutes(rootDir, DEFAULT_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(result.fileCount).toBe(1);
  });
});
