const { spawn } = require('child_process');

function createLineSplitter(onLine) {
  let buffer = '';

  return {
    push(data) {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          onLine && onLine(line);
        }
      }
    },
    flush() {
      if (buffer.trim()) {
        onLine && onLine(buffer);
      }
      buffer = '';
    }
  };
}

function runShellCommand(command, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: true
    });

    const splitter = createLineSplitter(options.onLine);

    child.stdout.on('data', splitter.push);
    child.stderr.on('data', splitter.push);
    child.on('close', (code) => {
      splitter.flush();
      resolve({ code });
    });
  });
}

/**
 * Runs a program with an argument list — no shell, so no argument is ever
 * re-parsed. stdout is captured (JSON answers of eas-cli, git output); both
 * streams are also streamed line by line to `onLine` unless `quiet` is set.
 * `input` is written to stdin (the script handed to `ssh host bash -s`).
 */
function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        shell: false
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    const onLine = options.quiet ? null : options.onLine;
    const outLines = createLineSplitter(onLine);
    const errLines = createLineSplitter(onLine);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (!options.quietStdout) {
        outLines.push(data);
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      errLines.push(data);
    });
    let settled = false;
    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      outLines.flush();
      errLines.flush();
      resolve({ code, stdout, stderr });
    };

    child.on('error', (error) => {
      stderr += error.message;
      settle(error.code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => settle(code === null ? 1 : code));
    child.stdin.on('error', () => {});

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

module.exports = {
  runProcess,
  runShellCommand
};
