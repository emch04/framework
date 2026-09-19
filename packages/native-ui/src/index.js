/**
 * @astratra/native-ui — the mobile interface kit: Liquid Glass on iOS, honest
 * surfaces on Android, bars that fold on scroll, AI answers rendered clean.
 *
 * This entry loads react-native and the Expo modules. The pure rules alone
 * live at `@astratra/native-ui/logic`, importable from plain Node.
 */
module.exports = {
  ...require('./logic'),
  ...require('./components/GlassSurface'),
  ...require('./components/GlassButton'),
  ...require('./components/PaleCard'),
  ...require('./components/Chevron'),
  ...require('./components/useCollapsingBar'),
  ...require('./components/FloatingPagination'),
  ...require('./components/TabBar'),
  ...require('./components/CollapsibleHeader'),
  ...require('./components/MarkdownView'),
  getGlassMode: require('./components/runtime').getGlassMode
};
