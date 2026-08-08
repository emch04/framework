module.exports = {
  ...require('./config'),
  ...require('./commands/auditSecrets'),
  ...require('./commands/auditRoutes'),
  ...require('./commands/auditI18n'),
  ...require('./commands/test'),
  ...require('./commands/deploy'),
  ...require('./cli')
};
