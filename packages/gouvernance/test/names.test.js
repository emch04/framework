'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Le pack est générique : aucun nom de projet ni de personne dans ses fichiers. */
const FORBIDDEN = /\b(roro|scolaris|tertius|barber|muzika|[ée]toffe|curie|solvia|palabre|cortex|emch|kongo|oracle|centrale)\b/i;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
    return [full];
  });
}

test('aucun nom de projet dans le pack', () => {
  const root = path.join(__dirname, '..');
  for (const file of files(root)) {
    if (file === path.join(__dirname, 'names.test.js') || file.endsWith('LICENSE')) continue;
    const match = fs.readFileSync(file, 'utf8').match(FORBIDDEN);
    assert.equal(match, null, `${path.relative(root, file)} : ${match?.[0]}`);
  }
});
