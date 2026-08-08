#!/usr/bin/env node

const { runCli } = require('../src/cli');

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`\x1b[31mERREUR\x1b[0m ${error.message}`);
  process.exitCode = error.statusCode && error.statusCode >= 400 ? 1 : 1;
});
