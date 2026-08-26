import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { GlassPanel } from '../components/GlassPanel';
import GridBackground from '../components/GridBackground';
import { colors, fontWeights, spacing } from '../constants/theme';

export default function Home() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <GridBackground />
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg }}>
        <GlassPanel>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: fontWeights.bold }}>{t('home.welcome')}</Text>
        <Text style={{ color: colors.muted, marginTop: spacing.sm }}>{t('app.name')}</Text>
        <AnimatedPressable
          onPress={() => router.push('/login')}
          style={{ marginTop: spacing.lg, backgroundColor: colors.accent, borderRadius: 14, padding: spacing.md }}
        >
          <Text style={{ color: colors.onAccent, textAlign: 'center', fontWeight: fontWeights.semibold }}>
            {t('home.start')}
          </Text>
        </AnimatedPressable>
        </GlassPanel>
      </View>
    </View>
  );
}
