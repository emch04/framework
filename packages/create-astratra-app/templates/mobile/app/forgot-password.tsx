/**
 * Asking for a reset link.
 *
 * The answer is deliberately the same whether the address exists or not: a
 * screen that says "unknown address" is an account-enumeration oracle.
 */
import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '../services/session';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { GlassPanel } from '../components/GlassPanel';
import { KeyboardScreen } from '../components/KeyboardScreen';
import GridBackground from '../components/GridBackground';
import { colors, fontWeights, spacing } from '../constants/theme';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    try {
      await api.request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
    } catch {
      /* same answer either way */
    }
    setSent(true);
  };

  return (
    <KeyboardScreen background={<GridBackground />} contentStyle={{ justifyContent: 'center', padding: spacing.lg }}>
      <GlassPanel>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: fontWeights.bold }}>{t('auth.forgot')}</Text>
        <TextInput
          style={{
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 14,
            padding: spacing.md,
            marginTop: spacing.md
          }}
          placeholder={t('auth.email')}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        {sent && <Text style={{ color: colors.muted, marginTop: spacing.sm }}>{t('auth.reset_sent')}</Text>}
        <AnimatedPressable
          onPress={submit}
          style={{ marginTop: spacing.lg, backgroundColor: colors.accent, borderRadius: 14, padding: spacing.md }}
        >
          <Text style={{ color: colors.onAccent, textAlign: 'center', fontWeight: fontWeights.semibold }}>
            {t('auth.send_link')}
          </Text>
        </AnimatedPressable>
      </GlassPanel>
    </KeyboardScreen>
  );
}
