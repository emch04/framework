const { spawn } = require('child_process');

function runShellCommand(command, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: true
    });

    let outputBuffer = '';

    const handleData = (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          options.onLine && options.onLine(line);
        }
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('close', (code) => {
      if (outputBuffer.trim()) {
        options.onLine && options.onLine(outputBuffer);
      }
      resolve({ code });
    });
  });
}

module.exports = {
  runShellCommand
};
