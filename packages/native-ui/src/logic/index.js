/**
 * The pure half of the kit: every rule the components follow, without
 * react-native. Importable from Node (`@astratra/native-ui/logic`) — a server
 * rendering the same Markdown, a test, a script.
 */
module.exports = {
  ...require('./color'),
  ...require('./glass'),
  ...require('./paleCard'),
  ...require('./collapse'),
  ...require('./tabBar'),
  ...require('./collapsibleHeader'),
  ...require('./markdown'),
  ...require('./tableColumns'),
  ...require('./anchorQuestion')
};
