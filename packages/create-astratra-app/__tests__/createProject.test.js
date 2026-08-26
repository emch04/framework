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
    force: true,
    bricks: []
  });
});

test('createProject writes a fullstack Astratra starter', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-app' }, cwd);

  assert.equal(result.targetDir, path.join(cwd, 'demo-app'));
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/server.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/config/env.js')), true);
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
  /* Read from the workspace, never written by hand: an assertion carrying a
     literal version passes happily while the generator ships a stale floor —
     which is exactly how six of them drifted unnoticed. */
  const versions = workspaceVersions();
  for (const name of ['@astratra/core', '@astratra/security', '@astratra/ai', '@astratra/saas-kit', '@astratra/saas-kit-ui']) {
    assert.equal(pkg.dependencies[name], `^${versions[name]}`, name);
  }
  assert.equal(pkg.dependencies['@astratra/store-mongo'], undefined);
  assert.equal(pkg.dependencies.mongoose, undefined);
  assert.equal(pkg.dependencies.express, undefined, 'express is only needed transitively via saas-kit now that the template has no direct express usage');
  assert.equal(pkg.optionalDependencies['@astratra/store-mongo'], `^${versions['@astratra/store-mongo']}`);
  assert.equal(pkg.optionalDependencies.mongoose, '^8.17.0');
  assert.equal(pkg.scripts.dev, 'node scripts/dev.js');
  assert.equal(pkg.scripts['dev:web'], 'vite --host 127.0.0.1');

  const apiServer = fs.readFileSync(path.join(result.targetDir, 'api/server.js'), 'utf8');
  const envConfig = fs.readFileSync(path.join(result.targetDir, 'api/config/env.js'), 'utf8');
  const authSecurity = fs.readFileSync(path.join(result.targetDir, 'api/security/auth.js'), 'utf8');
  const notificationsModule = fs.readFileSync(path.join(result.targetDir, 'api/modules/notifications.js'), 'utf8');
  const memoryStores = fs.readFileSync(path.join(result.targetDir, 'api/stores/memory.js'), 'utf8');
  const envExample = fs.readFileSync(path.join(result.targetDir, '.env.example'), 'utf8');
  assert.equal(apiServer.includes('./config/env.js'), true);
  assert.equal(apiServer.includes('./stores/memory.js'), true);
  assert.equal(apiServer.includes('./security/auth.js'), true);
  assert.equal(apiServer.includes('./modules/users.js'), true);
  assert.equal(apiServer.includes('./modules/notifications.js'), true);
  assert.equal(apiServer.includes('publicUserFields: userPublicFields()'), true);
  assert.equal(apiServer.includes('./ai/tools.js'), true);
  assert.equal(apiServer.includes('extendRoutes:'), true);
  assert.equal(apiServer.includes("saasApp.get('/api/status'"), true);
  assert.equal(apiServer.includes('cors: { allowedOrigins: env.corsOrigins }'), true);
  assert.equal(apiServer.includes("from 'express'"), false, 'server.js should not need express directly now that CORS goes through createSaasApp({ cors })');
  assert.match(envConfig, /process\.env\.PORT \? Number\(process\.env\.PORT\) : 0/);
  assert.equal(envConfig.includes('JWT_ISSUER'), true);
  assert.equal(envConfig.includes('JWT_AUDIENCE'), true);
  assert.equal(authSecurity.includes("jwtAlgorithms: ['HS256']"), true);
  assert.equal(authSecurity.includes('jwtIssuer'), true);
  assert.equal(authSecurity.includes('jwtAudience'), true);
  assert.equal(envConfig.includes('assertProductionEnv'), true);
  assert.equal(envConfig.includes('change-me-in-production'), true);
  assert.equal(notificationsModule.includes('notify: async (userId, notification)'), true);
  assert.equal(notificationsModule.includes('userId'), true);
  assert.equal(notificationsModule.includes('notification'), true);
  assert.equal(envExample.includes('JWT_ISSUER='), true);
  assert.equal(envExample.includes('JWT_AUDIENCE='), true);
  assert.equal(memoryStores.includes('../modules/settings.js'), true);
  assert.match(apiServer, /server\.address\(\)/);
  assert.match(apiServer, /Port \$\{port\} is already in use/);
  assert.equal(apiServer.includes("path.resolve('.astratra')"), true);

  const viteConfig = fs.readFileSync(path.join(result.targetDir, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /readApiUrl/);
  assert.match(viteConfig, /VITE_API_URL/);
  assert.doesNotMatch(viteConfig, /port: 5173/);
  assert.doesNotMatch(viteConfig, /4000/);

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

test('parseArgs reads --with as a comma list, and --with=all', () => {
  assert.deepEqual(parseArgs(['app', '--with', 'payments,privacy']).bricks, ['payments', 'privacy']);
  assert.equal(parseArgs(['app', '--with=all']).bricks.length, 11);
  assert.deepEqual(parseArgs(['app']).bricks, []);
});

test('a project without --with stays exactly as before', () => {
  // Les briques n'ont aucune dépendance précisément pour qu'on n'en prenne que
  // ce dont on a besoin : rien ne s'ajoute sans qu'on l'ait demandé.
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'plain-app' }, cwd);
  const pkg = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));

  assert.deepEqual(result.bricks, []);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/bricks')), false);
  assert.equal(Object.keys(pkg.dependencies).some((d) => d.includes('payments')), false);
});

test('a requested brick adds its dependency and its wired example', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'brick-app', bricks: ['payments', 'notify'] }, cwd);
  const pkg = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));

  const brickVersions = workspaceVersions();
  assert.equal(pkg.dependencies['@astratra/payments'], `^${brickVersions['@astratra/payments']}`);
  assert.equal(pkg.dependencies['@astratra/notify'], `^${brickVersions['@astratra/notify']}`);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/bricks/payments.js')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/bricks/notify.js')), true);
});

test('nothing is wired into server.js — a fresh app starts without configuration', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'unwired', bricks: ['credentials', 'payments'] }, cwd);
  const server = fs.readFileSync(path.join(result.targetDir, 'api/server.js'), 'utf8');

  assert.equal(server.includes('bricks/'), false);
  assert.equal(server.includes('@astratra/payments'), false);
});

test('a browser brick is refused on the api template rather than silently skipped', () => {
  assert.throws(() => parseArgs(['app', '--template', 'api', '--with', 'client']), /fullstack template/);
});

test('an unknown brick names the valid ones instead of failing vaguely', () => {
  assert.throws(() => parseArgs(['app', '--with', 'paiments']), /Unknown brick "paiments"/);
  assert.throws(() => parseArgs(['app', '--with', 'paiments']), /Available: credentials/);
});

test('a bad brick fails BEFORE any file is written', () => {
  const cwd = tempRoot();
  assert.throws(() => createProject({ targetDir: 'never-born', bricks: ['nope'] }, cwd));
  assert.equal(fs.existsSync(path.join(cwd, 'never-born', 'package.json')), false);
});

test('--with all takes what the template accepts, and no more', () => {
  const api = tempRoot();
  const apiResult = createProject({ targetDir: 'api-all', template: 'api', bricks: ['all'] }, api);
  assert.equal(apiResult.bricks.includes('client'), false);
  assert.equal(apiResult.bricks.includes('prerender'), false);
  assert.equal(apiResult.bricks.length, 9);

  const full = tempRoot();
  const fullResult = createProject({ targetDir: 'full-all', template: 'fullstack', bricks: ['all'] }, full);
  assert.equal(fullResult.bricks.length, 11);
  assert.equal(fs.existsSync(path.join(fullResult.targetDir, 'web/src/lib/client.js')), true);
  assert.equal(fs.existsSync(path.join(fullResult.targetDir, 'astratra.prerender.config.cjs')), true);
});

test('a repeated brick is installed once', () => {
  assert.deepEqual(parseArgs(['app', '--with', 'pdf', '--with', 'pdf']).bricks, ['pdf']);
});

test('every scaffolded brick file is valid JavaScript', async () => {
  // Un exemple qui ne compile pas est pire qu'aucun exemple : on le découvre
  // en le branchant, pas en le lisant.
  const { BRICK_NAMES } = await import('../src/bricks.js');
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'syntax-app', template: 'fullstack', bricks: ['all'] }, cwd);

  assert.equal(result.bricks.length, BRICK_NAMES.length);

  const { execFileSync } = await import('node:child_process');
  for (const relative of [
    'api/bricks/credentials.js', 'api/bricks/entitlements.js', 'api/bricks/notify.js',
    'api/bricks/payments.js', 'api/bricks/privacy.js', 'api/bricks/resilience.js',
    'api/bricks/i18n.js', 'api/bricks/pdf.js', 'api/bricks/closure.js',
    'web/src/lib/client.js', 'astratra.prerender.config.cjs'
  ]) {
    const file = path.join(result.targetDir, relative);
    assert.equal(fs.existsSync(file), true, `${relative} manquant`);
    // --check parse le fichier sans l'exécuter : les imports vers des packages
    // non installés dans ce dossier temporaire ne posent donc pas problème.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
});

test('parseArgs accepts the mobile template', () => {
  assert.deepEqual(parseArgs(['my-app', '--template', 'mobile']), {
    targetDir: 'my-app',
    template: 'mobile',
    force: false,
    bricks: []
  });
});

test('parseArgs refuses bricks on the mobile template — they are server wiring', () => {
  assert.throws(
    () => parseArgs(['my-app', '--template', 'mobile', '--with', 'credentials']),
    /mobile template takes no bricks/
  );
});

test('parseArgs names every template when it refuses one', () => {
  assert.throws(() => parseArgs(['my-app', '--template', 'desktop']), /api, fullstack or mobile/);
});

test('createProject writes an Expo app for the mobile template', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);

  for (const file of [
    'package.json',
    'app.config.js',
    'app/_layout.tsx',
    'app/login.tsx',
    'app/settings.tsx',
    'context/AuthContext.tsx',
    'services/session.ts',
    'services/push.ts',
    'features/routes.ts',
    'components/SessionGuard.tsx',
    'i18n/locales/fr.json'
  ]) {
    assert.equal(fs.existsSync(path.join(result.targetDir, file)), true, `missing ${file}`);
  }
});

test('the generated mobile app depends on the packages it is built on', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));

  assert.equal(manifest.name, 'demo-mobile');
  assert.ok(manifest.dependencies['@astratra/native']);
  assert.ok(manifest.dependencies['@astratra/client']);
  assert.ok(manifest.dependencies.expo);
});

test('dotfiles npm would have stripped are restored on copy', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);

  assert.equal(fs.existsSync(path.join(result.targetDir, '.gitignore')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, '.env.example')), true);
  assert.equal(fs.existsSync(path.join(result.targetDir, 'gitignore')), false);
});

test('the project name reaches the generated README', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);
  const readme = fs.readFileSync(path.join(result.targetDir, 'README.md'), 'utf8');

  assert.match(readme, /^# demo-mobile/);
  assert.equal(readme.includes('__PROJECT_NAME__'), false);
});

test('the mobile template ships the real component system', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);

  for (const file of [
    'components/KeyboardScreen.tsx',
    'components/glass/LiquidGlassSurface.tsx',
    'components/dashboard/DashboardHeader.tsx',
    'components/dashboard/KpiBubble.tsx',
    'components/dashboard/ToolCard.tsx',
    'components/dashboard/StaffTabBar.tsx',
    'components/onboarding/StepScreen.tsx',
    'constants/dashboard.ts'
  ]) {
    assert.equal(fs.existsSync(path.join(result.targetDir, file)), true, `missing ${file}`);
  }
});

test('nothing in the template still points at the project it came from', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.join(dir, entry.name)]
  ));

  for (const file of walk(result.targetDir)) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.equal(/scolaris/i.test(contents), false, `${file} still mentions its origin`);
  }
});

test('the template carries no other product identity — colours go through the theme', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);
  const components = path.join(result.targetDir, 'components');

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));

  // The two blues and the ink the ported components were written against.
  // Left as literals, every generated app inherits somebody else's identity.
  for (const file of walk(components)) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const literal of ['#3b6cf0', '#3d5afe', '#0d1235']) {
      assert.equal(contents.includes(literal), false, `${file} hard-codes ${literal}`);
    }
  }
});

test('the reanimated Babel plugin is wired — Skia needs it, and the failure is a runtime one', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);
  const babel = fs.readFileSync(path.join(result.targetDir, 'babel.config.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));

  assert.match(babel, /react-native-worklets\/plugin/);
  assert.ok(manifest.dependencies['react-native-reanimated']);
  assert.ok(manifest.dependencies['@shopify/react-native-skia']);
});

test('the mobile template writes no API server', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);

  assert.equal(fs.existsSync(path.join(result.targetDir, 'api/server.js')), false);
  assert.deepEqual(result.bricks, []);
});

/**
 * The floors the generator writes must match what the workspace publishes.
 *
 * They had drifted by six declarations, and every one of them failed SILENTLY:
 * a generated project installed an older package, and the feature the person
 * had just enabled simply did nothing. Worse on 0.x, where a caret does not
 * cross the minor — `^0.2.0` never installs 0.3.0.
 */
function workspaceVersions() {
  const packagesDir = path.resolve(import.meta.dirname, '../..');
  const versions = {};
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    versions[name] = version;
  }
  return versions;
}

test('the generated API asks for versions that actually contain the features', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-api', template: 'api' }, cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  const versions = workspaceVersions();

  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const [name, range] of Object.entries(declared)) {
    if (!name.startsWith('@astratra/')) continue;
    assert.equal(
      range,
      `^${versions[name]}`,
      `${name}: le générateur demande ${range}, l'espace de travail publie ${versions[name]}`
    );
  }
});

test('every brick asks for the version the workspace publishes', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-bricks', template: 'api', bricks: ['all'] }, cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  const versions = workspaceVersions();

  for (const [name, range] of Object.entries(manifest.dependencies)) {
    if (!name.startsWith('@astratra/')) continue;
    assert.equal(range, `^${versions[name]}`, `brique ${name}: ${range} ≠ ^${versions[name]}`);
  }
});

test('the mobile template asks for the packages it is built on, at their real versions', () => {
  const cwd = tempRoot();
  const result = createProject({ targetDir: 'demo-mobile', template: 'mobile' }, cwd);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, 'package.json'), 'utf8'));
  const versions = workspaceVersions();

  for (const name of ['@astratra/client', '@astratra/native']) {
    assert.equal(manifest.dependencies[name], `^${versions[name]}`, `${name} dans le gabarit mobile`);
  }
});
