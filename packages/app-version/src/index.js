module.exports = {
  ...require('./compareVersions'),
  ...require('./manifest'),
  ...require('./announce'),
  ...require('./versionStatus'),
  ...require('./storeWatcher')
};
