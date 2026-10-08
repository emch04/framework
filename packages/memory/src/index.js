module.exports = {
  ...require('./memory'),
  ...require('./memoryStore'),
  ...require('./postgres'),
  ...require('./tools'),
  ...require('./handlers'),
  ...require('./rules'),
  ...require('./ranking'),
  ...require('./consolidation'),
  ...require('./testing/storeContract')
};
