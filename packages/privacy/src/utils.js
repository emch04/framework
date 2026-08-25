/** Fail at wiring time rather than at the first request. */
function assertStore(store, methods, name) {
  for (const method of methods) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`Astratra privacy requires ${name}.${method}().`);
    }
  }
}

module.exports = { assertStore };
