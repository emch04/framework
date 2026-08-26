import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { TEXT, colors, fontWeights, fonts, inkAlpha } from "../../constants/theme";
import NotificationBell from "./NotificationBell";

export type DashboardHeaderProps = {
  name: string;
  online: boolean;
  /** Unread count for the bell. The screen owns the data; the header renders it. */
  unread?: number;
};

export default function DashboardHeader({ name, online, unread = 0 }: DashboardHeaderProps) {
  const { i18n, t } = useTranslation();
  const locale = i18n.language || "fr";
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));

  useEffect(() => {
    setClock(new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
    const timer = setInterval(() => {
      setClock(new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
    }, 60000);
    return () => clearInterval(timer);
  }, [locale]);

  const statusColor = online ? colors.positive : colors.danger;
  const dateLabel = new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.date}>{dateLabel}</Text>
        <View style={styles.greetRow}>
          <Text style={styles.greeting}>{t("dashboard.greeting")} </Text>
          <Text style={[styles.greeting, { color: colors.accent }]} numberOfLines={1}>{name}</Text>
        </View>
        <Text style={styles.subtitle}>{t("dashboard.header.subtitle")}</Text>
      </View>
      <View style={styles.right}>
        {/* La cloche remplace la carte « Notifications » de la grille : elle
            dit s'il y a quelque chose à lire sans qu'on l'ouvre. */}
        <View style={styles.bellRow}>
          <Text style={styles.clock}>{clock}</Text>
          <NotificationBell unread={unread} accent={colors.accent} />
        </View>
        <View style={[styles.pill, { backgroundColor: `${statusColor}1A`, borderColor: `${statusColor}40` }]}>
          <View style={[styles.dot, { backgroundColor: statusColor }]} />
          <Text style={[styles.pillText, { color: statusColor }]}>
            {online ? t("dashboard.header.online") : t("dashboard.header.offline")}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  left: { flex: 1, gap: 6 },
  date: { fontSize: 11, fontFamily: fonts.semibold, fontWeight: fontWeights.semibold, color: inkAlpha(0.40) },
  greetRow: { flexDirection: "row", flexWrap: "wrap" },
  greeting: { fontSize: 22, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, color: TEXT, letterSpacing: -0.5 },
  subtitle: { fontSize: 12.5, fontFamily: fonts.medium, fontWeight: fontWeights.medium, color: inkAlpha(0.40) },
  right: { alignItems: "flex-end", gap: 6 },
  bellRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  clock: { fontSize: 20, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, color: TEXT },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 50, borderWidth: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 9.5, fontFamily: fonts.bold, fontWeight: fontWeights.bold, letterSpacing: 0.6 },
});
