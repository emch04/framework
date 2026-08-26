/**
 * Signing in.
 *
 * The password rules come from @astratra/client and are the SAME object the
 * server validates against — a rule duplicated with a drift is a password
 * accepted on screen and refused on submit.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { createPasswordRules } from '@astratra/client';
import { useAuth } from '../context/AuthContext';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { GlassPanel } from '../components/GlassPanel';
import { KeyboardScreen } from '../components/KeyboardScreen';
import GridBackground from '../components/GridBackground';
import PasswordEyeIcon from '../components/PasswordEyeIcon';
import { colors, fontWeights, spacing } from '../constants/theme';

const rules = createPasswordRules();

export default function Login() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async () => {
    setFailed(false);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/dashboard');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const input = {
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.md,
    marginTop: spacing.sm
  };

  return (
    <KeyboardScreen background={<GridBackground />} contentStyle={{ justifyContent: 'center', padding: spacing.lg }}>
      <GlassPanel>
        <Text style={{ color: colors.text, fontSize: 24, fontWeight: fontWeights.bold }}>{t('auth.sign_in')}</Text>

        <TextInput
          style={input}
          placeholder={t('auth.email')}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <View>
          <TextInput
            style={[input, { paddingRight: spacing.xl + spacing.md }]}
            placeholder={t('auth.password')}
            placeholderTextColor={colors.muted}
            secureTextEntry={!revealed}
            value={password}
            onChangeText={setPassword}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(revealed ? 'auth.hide_password' : 'auth.show_password')}
            onPress={() => setRevealed((shown) => !shown)}
            /* A bigger touch area than the glyph: an 18px icon is below every
               platform's minimum target and is missed as often as it is hit. */
            hitSlop={12}
            style={{ position: 'absolute', right: spacing.md, top: 0, bottom: 0, justifyContent: 'center' }}
          >
            <PasswordEyeIcon visible={revealed} />
          </Pressable>
        </View>

        {/* Each condition separately, so the person sees WHICH one is missing
            while typing — not a single line they discover they failed on submit. */}
        {password.length > 0 && rules.check(password).map((rule) => (
          <Text key={rule.key} style={{ color: rule.met ? colors.accent : colors.muted, marginTop: spacing.xs }}>
            {rule.met ? '✓' : '·'} {t(`password.${rule.key}`)}
          </Text>
        ))}

        {failed && <Text style={{ color: colors.danger, marginTop: spacing.sm }}>{t('auth.failed')}</Text>}

        <AnimatedPressable
          onPress={submit}
          disabled={busy}
          style={{ marginTop: spacing.lg, backgroundColor: colors.accent, borderRadius: 14, padding: spacing.md }}
        >
          {busy
            ? <ActivityIndicator color={colors.onAccent} />
            : <Text style={{ color: colors.onAccent, textAlign: 'center', fontWeight: fontWeights.semibold }}>{t('auth.sign_in')}</Text>}
        </AnimatedPressable>

        <AnimatedPressable onPress={() => router.push('/forgot-password')} style={{ marginTop: spacing.md }}>
          <Text style={{ color: colors.muted, textAlign: 'center' }}>{t('auth.forgot')}</Text>
        </AnimatedPressable>
      </GlassPanel>
    </KeyboardScreen>
  );
}
