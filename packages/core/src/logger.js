const levels = {
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug'
};

function writeLog(level, serviceName, message, meta) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${serviceName}] ${level.toUpperCase()}: ${message}`;
  const writer = console[level] || console.log;

  if (meta === undefined) {
    writer(line);
    return;
  }

  writer(line, meta);
}

function createLogger(serviceName = 'app') {
  return Object.keys(levels).reduce((logger, level) => {
    logger[level] = (message, meta) => writeLog(level, serviceName, message, meta);
    return logger;
  }, {});
}

module.exports = createLogger;
