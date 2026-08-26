module.exports = {
  ...require('./sessionClient'),
  ...require('./routeGuard'),
  ...require('./passwordRules'),
  ...require('./queue'),
  ...require('./support'),
  ...require('./toolCatalog'),
  ...require('./resourcePayload'),
  ...require('./settingsMenu'),
  ...require('./homeRoutes')
};
