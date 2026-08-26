/**
 * The first step of a sign-up, and the shape every other step copies.
 *
 * A flow like this is a chain of `StepScreen`s: each one owns its fields and
 * says where "next" goes. The shell — progress, title, keyboard handling, the
 * back affordance — is not each screen's business.
 */
import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import StepScreen from '../../components/onboarding/StepScreen';
import { colors, fontWeights, spacing } from '../../constants/theme';

const TOTAL_STEPS = 2;

export default function OnboardingAccount() {
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');

  return (
    <StepScreen
      step={1}
      totalSteps={TOTAL_STEPS}
      eyebrow={t('onboarding.eyebrow')}
      title={t('onboarding.account_title')}
      onNext={() => router.push('/onboarding/done')}
      nextDisabled={!email.includes('@')}
      onSkip={() => router.replace('/login')}
    >
      <Text style={{ color: colors.muted, marginBottom: spacing.md }}>{t('onboarding.account_help')}</Text>
      <TextInput
        style={{
          color: colors.text,
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 14,
          padding: spacing.md,
          fontWeight: fontWeights.medium
        }}
        placeholder={t('auth.email')}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
    </StepScreen>
  );
}
