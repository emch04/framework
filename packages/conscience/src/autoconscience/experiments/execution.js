'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { ready, timeoutOf, fail } = require('./common');
/** Candidate source is executed in a fresh realm; no host callbacks or objects enter it. */
async function execute({ governor, organisationId, source, input, config = {}, timeoutMs = 1000 }) {
  await ready({ governor, organisationId });
  const timeout = timeoutOf(timeoutMs);
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'runner.js'), {
      workerData: { source, input: JSON.stringify(input), config: JSON.stringify(config), timeout },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      stdout: true, stderr: true, env: {}, execArgv: ['--experimental-vm-modules']
    });
    // No output of the candidate, including logs or thrown messages, is forwarded.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      worker.terminate().catch(() => {}); fn(value);
    };
    const timer = setTimeout(() => finish(resolve, { status: 'unknown', reason: 'timeout', intentions: 0 }), timeout + 500);
    worker.once('message', (message) => finish(resolve, message));
    worker.once('error', () => finish(resolve, { status: 'unknown', reason: 'execution_failed', intentions: 0 }));
    worker.once('exit', () => finish(resolve, { status: 'unknown', reason: 'execution_failed', intentions: 0 }));
    worker.once('messageerror', () => finish(reject, new Error('Invalid sandbox message.')));
  });
  await ready({ governor, organisationId });
  if (!result || !['completed', 'unknown'].includes(result.status)) fail('sandbox_invalid', 'Invalid sandbox result.');
  return result;
}
module.exports = { execute };
