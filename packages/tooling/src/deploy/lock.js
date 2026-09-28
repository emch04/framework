const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (_error) {
    return null;
  }
}

/**
 * One run at a time. A directory is created atomically or not at all (macOS
 * has no flock). The owner's pid is kept inside: a lock whose process is gone
 * (killed, machine rebooted) is taken over instead of blocking forever.
 */
function acquireLock(lockDir, options = {}) {
  const pid = options.pid || process.pid;
  const isAlive = options.isAlive || defaultIsAlive;
  const now = options.now || (() => Date.now());

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }));
      let released = false;
      return {
        path: lockDir,
        release() {
          if (released) {
            return;
          }
          released = true;
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      const owner = readOwner(lockDir);
      const stale = owner && Number.isInteger(owner.pid) && !isAlive(owner.pid);
      if (!stale || attempt > 0) {
        throw new ToolingError(
          'DEPLOY_LOCKED',
          `Un autre deploiement tourne deja${owner && owner.pid ? ` (pid ${owner.pid})` : ''}. Verrou : ${lockDir}`,
          409
        );
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  throw new ToolingError('DEPLOY_LOCKED', `Verrou impossible a prendre : ${lockDir}`, 409);
}

module.exports = {
  acquireLock
};
