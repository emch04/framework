import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProject, parseArgs } from '../src/createProject.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-create-'));
}

test('parseArgs reads target, template and force flag', () => {
  assert.deepEqual(parseArgs(['my-app', '--template', 'api', '--force']), {
    targetDir: 'my-app',
    template: 'api',
    force: true
  });
});

test('createProject writes a fullstack Astratra starter', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-app' }, cwd);

  assert.equal(result.targetDir, path.join(cwd, 'demo-app'));
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/server.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/config/env.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/config/cors.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/security/auth.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/security/rateLimit.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/security/waf.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/stores/memory.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/stores/mongo.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/db/mongo.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/ai/providers.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/ai/tools.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/ai/agent.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/modules/users.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/modules/settings.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/modules/notifications.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'scripts/dev.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'web/src/main.jsx')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, '.gitignore')), true);

  const pkg = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'demo-app');
  assert.equal(pkg.dependencies['@astratra/core'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/security'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/ai'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/saas-kit'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/store-mongo'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/saas-kit-ui'], '^0.1.0');
  assert.equal(pkg.dependencies.mongoose, '^8.17.0');
  assert.equal(pkg.scripts.dev, 'node scripts/dev.js');
  assert.equal(pkg.scripts['dev:web'], 'vite --host 127.0.0.1');

  const apiServer = fs.readFileSync(path.join(result.targetDir, 'api/server.js'), 'utf8');
  const envConfig = fs.readFileSync(path.join(result.targetDir, 'api/config/env.js'), 'utf8');
  const corsConfig = fs.readFileSync(path.join(result.targetDir, 'api/config/cors.js'), 'utf8');
  const memoryStores = fs.readFileSync(path.join(result.targetDir, 'api/stores/memory.js'), 'utf8');
  assert.equal(apiServer.includes('./config/env.js'), true);
  assert.equal(apiServer.includes('./stores/memory.js'), true);
  assert.equal(apiServer.includes('./security/auth.js'), true);
  assert.equal(apiServer.includes('./modules/users.js'), true);
  assert.equal(apiServer.includes('./modules/notifications.js'), true);
  assert.equal(apiServer.includes('publicUserFields: userPublicFields()'), true);
  assert.match(envConfig, /process\.env\.PORT \? Number\(process\.env\.PORT\) : 0/);
  assert.equal(memoryStores.includes('../modules/settings.js'), true);
  assert.match(apiServer, /server\.address\(\)/);
  assert.match(apiServer, /Port \$\{port\} is already in use/);
  assert.equal(apiServer.includes("path.resolve('.astratra')"), true);
  assert.match(corsConfig, /isAllowedDevOrigin/);
  assert.equal(corsConfig.includes('127.0.0.1'), true);
  assert.equal(corsConfig.includes('localhost'), true);

  const viteConfig = fs.readFileSync(path.join(result.targetDir, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /readApiUrl/);
  assert.match(viteConfig, /VITE_API_URL/);
  assert.doesNotMatch(viteConfig, /port: 5173/);

  const devScript = fs.readFileSync(path.join(result.targetDir, 'scripts/dev.js'), 'utf8');
  assert.match(devScript, /dev:api/);
  assert.match(devScript, /dev:web/);
  assert.match(devScript, /api\.json/);
  assert.match(devScript, /findFreePort/);
  assert.match(devScript, /--port/);
});

test('createProject refuses a non-empty directory unless forced', () => {
  const cwd = tempRoot();
  const target = path.join(cwd, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'existing.txt'), 'keep');

  assert.throws(
    () => createProject({ targetDir: 'busy' }, cwd),
    /Target directory is not empty/
  );
});
