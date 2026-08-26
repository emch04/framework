/**
 * The app's identity, read at build time.
 *
 * The API URL is NOT baked in here as a literal: staging and production build
 * from the same source. It arrives through the environment, and the code has a
 * development default so a fresh clone runs without any setup.
 *
 * A KEY WITH NO VALUE IS OMITTED, NEVER SET TO null. Expo serialises `null` in
 * `extra` as `{}` — an empty object, which is truthy. A `projectId: null`
 * therefore reaches the CLI as `projectId: {}`, and manifest signing crashes
 * with "path must be of type string" before the app ever loads.
 */
const extra = {};

if (process.env.EXPO_PUBLIC_API_BASE_URL) {
  extra.apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
}

if (process.env.EAS_PROJECT_ID) {
  extra.eas = { projectId: process.env.EAS_PROJECT_ID };
}

module.exports = {
  expo: {
    name: 'Astratra App',
    slug: 'astratra-app',
    scheme: 'astratraapp',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: { supportsTablet: true, bundleIdentifier: 'com.example.astratraapp' },
    android: { package: 'com.example.astratraapp', edgeToEdgeEnabled: true },
    plugins: ['expo-router', 'expo-secure-store', 'expo-notifications', 'expo-local-authentication'],
    extra
  }
};
