/**
 * The dashboard, built from the real components.
 *
 * Everything on this screen is DATA, not markup: the KPI row and the tiles are
 * declared as lists, so a product changes what its dashboard shows by editing
 * `constants/dashboard.ts` — not by rewriting a screen. That is what lets one
 * dashboard serve several roles.
 */
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import DashboardReveal from '../components/dashboard/DashboardReveal';
import KpiBubble from '../components/dashboard/KpiBubble';
import MoreButton from '../components/dashboard/MoreButton';
import StaffTabBar from '../components/dashboard/StaffTabBar';
import ToolCard from '../components/dashboard/ToolCard';
import { useAuth } from '../context/AuthContext';
import { colors, spacing } from '../constants/theme';
import GridBackground from '../components/GridBackground';
import { dashboardKpis, dashboardTabs, dashboardTools } from '../constants/dashboard';

export default function Dashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const router = useRouter();

  const kpis = useMemo(() => dashboardKpis(t), [t]);
  const tools = useMemo(() => dashboardTools(t), [t]);
  const tabs = useMemo(() => dashboardTabs(t), [t]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <GridBackground />
      {/* Room at the bottom for the tab bar, which floats over the content. */}
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl * 2, paddingBottom: 120 }}>
        <DashboardHeader name={user?.fullName || user?.email || ''} online unread={0} />

        <DashboardReveal delay={60}>
          <View style={{ marginTop: spacing.lg }}>
            <KpiBubble items={kpis} />
          </View>
        </DashboardReveal>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: spacing.lg }}>
          {tools.map((tool, index) => (
            <DashboardReveal key={tool.label} delay={120 + index * 60}>
              <ToolCard
                card={tool}
                index={index}
                gridPadding={spacing.lg * 2}
                onPress={() => tool.path && router.push(tool.path as never)}
              />
            </DashboardReveal>
          ))}
        </View>

        <MoreButton
          label={t('dashboard.see_all')}
          delay={120 + tools.length * 60}
          onPress={() => router.push('/settings' as never)}
        />
      </ScrollView>

      <StaffTabBar
        tabs={tabs}
        activeKey="home"
        onSelect={(tab) => tab.path && router.push(tab.path as never)}
      />
    </View>
  );
}
