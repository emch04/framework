/**
 * The shell every screen sits in: session, guard, notifications, language.
 *
 * The order matters. The guard must be INSIDE the auth provider — it needs to
 * know whether the session is still restoring — and the notification listeners
 * must start after both, because where a tapped notification leads depends on
 * who is signed in.
 */
import { useEffect } from 'react';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { SessionGuard } from '../components/SessionGuard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { push } from '../services/push';
import '../i18n/config';

/**
 * Expo Go cannot receive push notifications — remote push was removed from it
 * in SDK 53 — and merely touching the module there raises a red error banner
 * over a perfectly healthy app. Starting the listeners is skipped, rather than
 * attempted and failed noisily.
 *
 * Nothing else changes: in a development build, and in the shipped app, this
 * is false and the listeners start normally.
 */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

function NotificationBridge() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user || IN_EXPO_GO) return undefined;
    let stop: (() => void) | undefined;
    void push.startListeners(user.role).then((dispose) => { stop = dispose; });
    return () => { if (stop) stop(); };
  }, [user]);

  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AuthProvider>
          <SessionGuard>
            <NotificationBridge />
            <StatusBar style="light" />
            <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
          </SessionGuard>
        </AuthProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
