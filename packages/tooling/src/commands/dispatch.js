const fs = require('fs');
const path = require('path');
const colors = require('../colors');
const { ToolingError } = require('../errors');
const { authorizedKeysLine, generateDispatcherScript } = require('../dispatch/dispatcher');

/**
 * `astratra dispatch:generate [--out=<file>] [--key=<file.pub>]`
 * Writes the forced-command script (0755) and prints the authorized_keys line
 * for the given public key. Nothing is installed in ~/.ssh: the line is shown,
 * the owner pastes it.
 */
async function runDispatchGenerate(rootDir, config, options = {}) {
  const output = options.output || console;
  const dispatch = (config && config.dispatch) || {};

  try {
    const script = generateDispatcherScript(dispatch);
    const out = options.out || dispatch.output;
    let written = null;

    if (out) {
      written = path.resolve(rootDir, String(out));
      fs.mkdirSync(path.dirname(written), { recursive: true });
      fs.writeFileSync(written, script, { mode: 0o755 });
      fs.chmodSync(written, 0o755);
      output.log(colors.green(`Script ecrit : ${written}`));
    } else {
      output.log(script);
    }

    const keyFile = options.key || dispatch.publicKeyFile;
    let line = null;
    if (keyFile) {
      const scriptPath = dispatch.installPath || written;
      if (!scriptPath) {
        throw new ToolingError('DISPATCH_SCRIPT_PATH_INVALID', 'dispatch.installPath (ou --out) est requis pour la ligne authorized_keys.', 400);
      }
      const publicKey = fs.readFileSync(path.resolve(rootDir, String(keyFile)), 'utf8').trim();
      line = authorizedKeysLine({ scriptPath, publicKey, from: dispatch.from });
      output.log('\nLigne a ajouter a ~/.ssh/authorized_keys :');
      output.log(line);
    }

    return { exitCode: 0, script, written, authorizedKeysLine: line };
  } catch (error) {
    output.log(colors.red(error.message));
    return { exitCode: 1, error: { code: error.code, message: error.message } };
  }
}

module.exports = {
  runDispatchGenerate
};
