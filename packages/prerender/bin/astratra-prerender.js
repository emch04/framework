#!/usr/bin/env node
const { resolve } = require('path');
const { prerender } = require('../src');
const configArg = process.argv.indexOf('--config');
const configPath = configArg >= 0 ? process.argv[configArg + 1] : 'astratra.prerender.config.cjs';
if (!configPath) throw new Error('--config needs a file path.');
const config = require(resolve(process.cwd(), configPath));
prerender(config).catch((error) => { console.error(error.stack || error.message); process.exit(1); });
