/**
 * `react-native-worklets/plugin` is not optional.
 *
 * Reanimated 4 compiles its worklets through this Babel plugin, and Skia's
 * animation layer pulls Reanimated in. Without it the bundle builds fine and
 * then throws at runtime — the failure looks like a missing package, not like
 * a missing Babel plugin.
 *
 * It must stay LAST in the list.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin']
  };
};
