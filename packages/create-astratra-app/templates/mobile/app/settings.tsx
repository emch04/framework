/**
 * Settings: two switches that both talk to the device, not just to the app.
 *
 * The push switch is driven by the controller from @astratra/native — the one
 * that re-reads the real state after every action instead of assuming its own
 * success, and that publishes nothing once the screen is gone.
 */
import { useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createBiometricGate, createPushSettingsController, isPushEnabled } from '@astratra/native';
import { useAuth } from '../context/AuthContext';
import { push } from '../services/push';
import { NAMESPACE } from '../services/session';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { GlassPanel } from '../components/GlassPanel';
import { colors, fontWeights, spacing } from '../constants/theme';
import GridBackground from '../components/GridBackground';

const gate = createBiometricGate({
  keystore: SecureStore,
  authenticator: LocalAuthentication,
  namespace: NAMESPACE
});

export default function Settings() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const [biometric, setBiometric] = useState({ enabled: false, supported: false });
  const [pushState, setPushState] = useState({ state: 'loading' as string, busy: false });
  const [togglePush, setTogglePush] = useState<() => void>(() => () => {});

  useEffect(() => {
    void gate.read().then(setBiometric);
  }, []);

  useEffect(() => {
    const controller = createPushSettingsController(
      {
        getState: () => push.getState(),
        enable: () => push.enable(),
        disable: () => push.disable(),
        openSettings: () => Linking.openSettings()
      },
      setPushState
    );
    const screen = controller.activate();
    setTogglePush(() => () => void controller.act());
    return () => screen.dispose();
  }, []);

  const toggleBiometric = async () => {
    const next = biometric.enabled ? await gate.disable() : await gate.enable({ promptMessage: t('app.name') });
    setBiometric(await gate.read());
    void next;
  };

  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <GridBackground />
      <View style={{ flex: 1, padding: spacing.lg, paddingTop: spacing.xl * 2 }}>
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: fontWeights.bold }}>{t('settings.title')}</Text>

      {biometric.supported && (
        <GlassPanel style={{ marginTop: spacing.lg }}>
          <View style={row}>
            <Text style={{ color: colors.text }}>{t('settings.biometric')}</Text>
            <Switch value={biometric.enabled} onValueChange={toggleBiometric} />
          </View>
        </GlassPanel>
      )}

      <GlassPanel style={{ marginTop: spacing.md }}>
        <View style={row}>
          <Text style={{ color: colors.text }}>{t('settings.notifications')}</Text>
          <Switch value={isPushEnabled(pushState.state)} disabled={pushState.busy} onValueChange={togglePush} />
        </View>
      </GlassPanel>

      <AnimatedPressable onPress={signOut} style={{ marginTop: spacing.xl }}>
        <GlassPanel>
          <Text style={{ color: colors.danger, textAlign: 'center', fontWeight: fontWeights.semibold }}>
            {t('settings.sign_out')}
          </Text>
        </GlassPanel>
      </AnimatedPressable>
      </View>
    </View>
  );
}
