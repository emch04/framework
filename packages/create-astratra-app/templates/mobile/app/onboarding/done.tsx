/**
 * The closing screen of the flow — the one showcase screen in the template.
 *
 * `BrandBackground` is for exactly this: a full-bleed gradient with almost
 * nothing on it. It is NOT for screens carrying content, where coloured ink on
 * a saturated gradient stops being readable.
 */
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import BrandBackground from '../../components/BrandBackground';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { colors, fontWeights, spacing } from '../../constants/theme';

export default function OnboardingDone() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <BrandBackground>
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl }}>
        <Text style={{ color: colors.onAccent, fontSize: 32, fontWeight: fontWeights.bold }}>
          {t('onboarding.done_title')}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.82)', marginTop: spacing.sm, fontSize: 16 }}>
          {t('onboarding.done_help')}
        </Text>

        <AnimatedPressable
          onPress={() => router.replace('/login')}
          style={{
            marginTop: spacing.xl,
            backgroundColor: colors.onAccent,
            borderRadius: 14,
            padding: spacing.md
          }}
        >
          <Text style={{ color: colors.accent, textAlign: 'center', fontWeight: fontWeights.semibold }}>
            {t('auth.sign_in')}
          </Text>
        </AnimatedPressable>
      </View>
    </BrandBackground>
  );
}
