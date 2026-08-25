const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workspaces = [
  '@astratra/core',
  '@astratra/security',
  '@astratra/ai',
  '@astratra/credentials',
  '@astratra/entitlements',
  '@astratra/i18n-server',
  '@astratra/pdf',
  '@astratra/payments',
  '@astratra/privacy',
  '@astratra/resilience',
  '@astratra/closure',
  '@astratra/notify',
  '@astratra/client',
  '@astratra/prerender',
  '@astratra/react',
  '@astratra/tooling',
  '@astratra/saas-kit',
  '@astratra/saas-kit-ui',
  '@astratra/store-mongo',
  '@astratra/store-postgres',
  'create-astratra-app'
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-package-install-'));
const tarballDir = path.join(tempDir, 'tarballs');
const projectDir = path.join(tempDir, 'project');
fs.mkdirSync(tarballDir);
fs.mkdirSync(projectDir);

try {
  const tarballs = workspaces.map((workspace) => {
    const output = execFileSync('npm', [
      'pack', '--workspace', workspace, '--json', '--pack-destination', tarballDir
    ], { cwd: root, encoding: 'utf8' });
    const [{ filename }] = JSON.parse(output);
    return path.join(tarballDir, filename);
  });

  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'astratra-package-install-check',
    private: true
  }, null, 2));

  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs
  ], { cwd: projectDir, stdio: 'inherit' });

  execFileSync(process.execPath, ['-e', [
    "require('@astratra/core')",
    "require('@astratra/security')",
    "require('@astratra/ai')",
    "require('@astratra/credentials')",
    "require('@astratra/entitlements')",
    "require('@astratra/i18n-server')",
    "require('@astratra/pdf')",
    "require('@astratra/payments')",
    "require('@astratra/privacy')",
    "require('@astratra/resilience')",
    "require('@astratra/closure')",
    "require('@astratra/notify')",
    "require('@astratra/client')",
    "require('@astratra/prerender')",
    "require('@astratra/tooling')",
    "require('@astratra/saas-kit')",
    "require('@astratra/store-mongo')",
    "require('@astratra/store-postgres')"
  ].join(';')], { cwd: projectDir, stdio: 'inherit' });

  execFileSync(process.execPath, ['--input-type=module', '-e', "import('@astratra/react')"], {
    cwd: projectDir,
    stdio: 'inherit'
  });

  console.log('All Astratra package archives install and load successfully.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
