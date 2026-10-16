const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('chaque dépendance déclarée est chargée par src : aucune installée pour rien', () => {
  const { dependencies = {} } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const code = sourceFiles(path.join(root, 'src')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const unused = Object.keys(dependencies).filter((name) =>
    !code.includes(`require('${name}')`) && !code.includes(`require('${name}/`));
  assert.deepEqual(unused, []);
});
