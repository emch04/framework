#!/usr/bin/env node
/**
 * Downloads the current LiteLLM price catalog as a new dated copy in data/,
 * prints what changed against the bundled copy, and rewrites data/NOTICE.
 * Never run automatically: a price change is reviewed before it ships.
 *
 *   node scripts/update-prices.js             # writes data/prix-modeles-<today>.json, removes the older copy
 *   node scripts/update-prices.js --dry-run   # only prints the summary
 *   node scripts/update-prices.js --all       # prints every line of the summary
 *   node scripts/update-prices.js --date 2026-10-01 --url <catalog url>
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bundledCatalogFile, diffPriceCatalogs, CATALOG_URL } = require('../src/pricing');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIST_LIMIT = 40;

function parseArgs(argv) {
  const args = { dryRun: false, all: false, date: new Date().toISOString().slice(0, 10), url: CATALOG_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--url') args.url = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) throw new Error('--date must be YYYY-MM-DD');
  if (!/^https:\/\//.test(args.url || '')) throw new Error('--url must be an https URL');
  return args;
}

/* A download that is not a catalog (HTML error page, truncated file) is refused. */
function validateCatalog(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a JSON object');
  const models = Object.entries(data).filter(([key]) => key !== 'sample_spec');
  const priced = models.filter(([, entry]) => entry && typeof entry.litellm_provider === 'string');
  if (priced.length < 500) throw new Error(`Only ${priced.length} models with a provider: refusing a partial catalog`);
}

function noticeText({ date, url, sha256 }) {
  return `Le fichier prix-modeles-${date}.json est une copie non modifiée de
model_prices_and_context_window.json, tiré du projet LiteLLM :
  ${url}
téléchargé le ${date}, empreinte SHA-256 ${sha256}.

Ce fichier est hors du dossier enterprise/ de LiteLLM et relève donc de la
licence MIT ci-dessous.

MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function printList(title, lines, all) {
  console.log(`\n${title} (${lines.length})`);
  for (const line of all ? lines : lines.slice(0, LIST_LIMIT)) console.log(`  ${line}`);
  if (!all && lines.length > LIST_LIMIT) console.log(`  ... ${lines.length - LIST_LIMIT} de plus (--all)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const response = await globalThis.fetch(args.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${args.url}`);
  const text = await response.text();
  const next = JSON.parse(text);
  validateCatalog(next);

  const current = bundledCatalogFile(DATA_DIR);
  const before = current ? JSON.parse(fs.readFileSync(current.file, 'utf8')) : {};
  const diff = diffPriceCatalogs(before, next);

  console.log(`Catalogue actuel : ${current ? path.basename(current.file) : 'aucun'}`);
  console.log(`Nouveau : ${Object.keys(next).length - 1} modèles, du ${args.date}`);
  printList('Ajoutés', diff.added, args.all);
  printList('Retirés', diff.removed, args.all);
  printList('Prix ou fenêtre changés', diff.changed.map((c) => `${c.key} ${c.field}: ${c.before} -> ${c.after}`), args.all);

  if (args.dryRun) {
    console.log('\n--dry-run : rien n’est écrit.');
    return;
  }
  const target = path.join(DATA_DIR, `prix-modeles-${args.date}.json`);
  fs.writeFileSync(target, text);
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(DATA_DIR, 'NOTICE'), noticeText({ date: args.date, url: args.url, sha256 }));
  if (current && current.file !== target) fs.unlinkSync(current.file);
  console.log(`\nÉcrit : ${path.relative(process.cwd(), target)} (les tests et la revue du diff avant publication).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validateCatalog, noticeText };
