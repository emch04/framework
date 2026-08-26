/**
 * The notification list, and the foreground watch that keeps it live.
 *
 * The first sweep raises no banner: on launch every unread item looks new, and
 * twenty banners at once is how notifications get switched off for good.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { FOREGROUND_POLL_MS, freshItems, nextStamp, shouldPoll } from '@astratra/native';
import { api } from '../services/session';
import { useAuth } from '../context/AuthContext';
import { GlassPanel } from '../components/GlassPanel';
import { colors, fontWeights, spacing } from '../constants/theme';
import GridBackground from '../components/GridBackground';

type Item = { id: string; title?: string; message?: string; createdAt?: string; read?: boolean };

export default function Notifications() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;

    const sweep = async () => {
      if (!shouldPoll(AppState.currentState, Boolean(user))) return;
      try {
        const list = await api.request<Item[]>('/notifications');
        if (!alive) return;
        setItems(list);
        /* Banner only what arrived since the last sweep, then move the mark —
           forward only, or the same item banners again next time. */
        void freshItems(list, lastSeen.current);
        lastSeen.current = nextStamp(list, lastSeen.current);
      } catch {
        /* a failed sweep is not worth a message: the next one is 30s away */
      }
    };

    void sweep();
    const timer = setInterval(sweep, FOREGROUND_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [user]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <GridBackground />
      <View style={{ flex: 1, padding: spacing.lg, paddingTop: spacing.xl * 2 }}>
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: fontWeights.bold }}>{t('notifications.title')}</Text>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={{ color: colors.muted, marginTop: spacing.lg }}>{t('notifications.empty')}</Text>}
        renderItem={({ item }) => (
          <GlassPanel style={{ marginTop: spacing.sm }}>
            <Text style={{ color: colors.text, fontWeight: fontWeights.semibold }}>{item.title}</Text>
            <Text style={{ color: colors.muted, marginTop: spacing.xs }}>{item.message}</Text>
          </GlassPanel>
        )}
      />
      </View>
    </View>
  );
}
