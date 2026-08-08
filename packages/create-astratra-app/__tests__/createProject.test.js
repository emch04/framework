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
  assert.equal(fs.existsSync(path.join(result.targetDir, 'web/src/main.jsx')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, '.gitignore')), true);

  const pkg = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'demo-app');
  assert.equal(pkg.dependencies['@astratra/saas-kit'], '^0.1.0');
  assert.equal(pkg.dependencies['@astratra/saas-kit-ui'], '^0.1.0');
  assert.equal(pkg.scripts['dev:web'], 'vite --host 127.0.0.1');

  const apiServer = fs.readFileSync(path.join(result.targetDir, 'api/server.js'), 'utf8');
  assert.match(apiServer, /Port \$\{port\} is already in use/);
  assert.equal(apiServer.includes("path.resolve('.astratra')"), true);

  const viteConfig = fs.readFileSync(path.join(result.targetDir, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /readApiUrl/);
  assert.match(viteConfig, /VITE_API_URL/);
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
