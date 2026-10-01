const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

/* La liste se lit dans packages/ : une liste écrite à la main oubliait les
   nouveaux paquets et gardait ceux qu'on avait fusionnés. Tout paquet publiable
   (non privé) est empaqueté, installé dans un projet vierge, puis chargé. */
const packages = fs.readdirSync(path.join(root, 'packages'))
  .map((dir) => path.join(root, 'packages', dir, 'package.json'))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
  .filter((pkg) => !pkg.private)
  .sort((a, b) => a.name.localeCompare(b.name));

/* Ce que Node charge pour vérifier chaque paquet, quand ce n'est pas son
   point d'entrée principal. `null` : rien à charger dans Node. */
const entryOverrides = {
  // Point d'entrée React Native : seules les règles pures se chargent dans Node.
  '@astratra/native-ui': '@astratra/native-ui/logic',
  // Composants .jsx livrés tels quels, compilés par le bundler du projet.
  '@astratra/saas-kit-ui': null,
  // Générateur en ligne de commande, sans point d'entrée à charger.
  'create-astratra-app': null
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-package-install-'));
const tarballDir = path.join(tempDir, 'tarballs');
const projectDir = path.join(tempDir, 'project');
fs.mkdirSync(tarballDir);
fs.mkdirSync(projectDir);

try {
  const tarballs = packages.map(({ name }) => {
    const output = execFileSync('npm', [
      'pack', '--workspace', name, '--json', '--pack-destination', tarballDir
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

  const required = [];
  const imported = [];
  for (const pkg of packages) {
    const entry = Object.prototype.hasOwnProperty.call(entryOverrides, pkg.name)
      ? entryOverrides[pkg.name]
      : pkg.name;
    if (entry === null) continue;
    (pkg.type === 'module' ? imported : required).push(entry);
  }

  execFileSync(process.execPath, ['-e',
    required.map((entry) => `require(${JSON.stringify(entry)})`).join(';')
  ], { cwd: projectDir, stdio: 'inherit' });

  execFileSync(process.execPath, ['--input-type=module', '-e',
    imported.map((entry) => `await import(${JSON.stringify(entry)});`).join('\n')
  ], { cwd: projectDir, stdio: 'inherit' });

  console.log(`${packages.length} Astratra package archives install; ${required.length + imported.length} load successfully.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
