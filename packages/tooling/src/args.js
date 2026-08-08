function parseArgs(argv = []) {
  const args = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const raw = arg.slice(2);
    const separatorIndex = raw.indexOf('=');

    if (separatorIndex === -1) {
      args[raw] = true;
      continue;
    }

    args[raw.slice(0, separatorIndex)] = raw.slice(separatorIndex + 1);
  }

  return args;
}

module.exports = parseArgs;
