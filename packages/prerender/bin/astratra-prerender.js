#!/usr/bin/env node
const { resolve } = require('path');
const { prerender } = require('../src');
const configArg = process.argv.indexOf('--config');
const configPath = configArg >= 0 ? process.argv[configArg + 1] : 'astratra.prerender.config.cjs';
if (!configPath) throw new Error('--config needs a file path.');
const config = require(resolve(process.cwd(), configPath));
prerender(config)
  // Les avertissements ne bloquent pas le build, mais doivent être vus : sans
  // cette ligne, seul un appel programmatique pouvait les lire.
  .then(({ warnings }) => { for (const warning of warnings) console.warn(`[astratra-prerender] ${warning}`); })
  .catch((error) => { console.error(error.stack || error.message); process.exit(1); });
