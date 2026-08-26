/**
 * Native notifications, wired to this app.
 *
 * The state machine is in @astratra/native. What belongs here is what the
 * package refuses to guess: which Android channels exist, which action buttons
 * a notification may carry, and which API endpoints register a device.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { createPushService } from '@astratra/native';
import { api, NAMESPACE } from './session';
import { notificationRouter } from '../features/routes';

/**
 * THE NATIVE MODULES ARE LOADED ON DEMAND, NOT AT IMPORT.
 *
 * `expo-notifications` complains loudly the moment it is imported in Expo Go
 * on Android — remote push was removed from it in SDK 53 — and a red error
 * banner greets anyone who merely opens the app, before any notification is
 * involved. Importing here, inside `load()`, means the module is touched only
 * when push is actually used, which in Expo Go is never.
 *
 * This is the whole reason `createPushService` takes an async loader.
 */
async function loadNativeModules() {
  const [Notifications, Device, Crypto, SecureStore] = await Promise.all([
    import('expo-notifications'),
    import('expo-device'),
    import('expo-crypto'),
    import('expo-secure-store')
  ]);

  return {
    notifications: Notifications,
    isDevice: Device.isDevice,
    deviceName: Device.deviceName,
    randomUUID: Crypto.randomUUID,
    keystore: SecureStore
  };
}

export const push = createPushService({
  namespace: NAMESPACE,
  load: async () => ({
    ...(await loadNativeModules()),
    platform: Platform.OS,
    projectId: Constants.easConfig?.projectId
      || (Constants.expoConfig?.extra as { eas?: { projectId?: string } })?.eas?.projectId,
    /* Android groups notifications by channel, and a channel's importance
       cannot be raised after it is created — declare them deliberately. */
    channels: [{ id: `${NAMESPACE}-general`, name: 'General' }],
    categories: [],
    router: notificationRouter,
    navigate: (route: string) => router.push(route as never),
    api: {
      register: (registration) => api.request('/notifications/devices', {
        method: 'POST',
        body: JSON.stringify(registration)
      }),
      current: (installationId) => api.request(`/notifications/devices/${installationId}`),
      unregister: (installationId) => api.request(`/notifications/devices/${installationId}`, {
        method: 'DELETE'
      })
    }
  })
});
