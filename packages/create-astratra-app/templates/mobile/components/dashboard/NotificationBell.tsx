import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import Svg, { Path } from "react-native-svg";
import AnimatedPressable from "../AnimatedPressable";
import { TEXT, card, colors, fontWeights, fonts } from "../../constants/theme";

const BELL = "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0";

/**
 * La cloche, avec le nombre de notifications non lues.
 *
 * Elle remplace la carte « Notifications » qui occupait une place dans la
 * grille de chaque tableau de bord. Une carte ne dit pas s'il y a quelque
 * chose à lire : il fallait l'ouvrir pour le découvrir. Une cloche avec son
 * compte le dit sans qu'on la touche, et rend sa place à ce qui compte.
 *
 * Le compte se rafraîchit à chaque retour sur l'écran : une notification lue
 * ailleurs ne doit pas laisser une pastille qui ment.
 */
/**
 * The bell, and nothing else.
 *
 * It used to fetch its own count, which tied one small piece of chrome to an
 * API shape and made it impossible to render in a test or a preview. The
 * screen owns the data; the bell renders what it is given.
 */
export default function NotificationBell({
  unread = 0,
  accent,
  onPress
}: {
  unread?: number;
  accent?: string;
  /** Defaults to the notifications screen. */
  onPress?: () => void;
}) {
  const { t } = useTranslation();

  /* Capped at 99+: three digits do not fit, and "1247 unread" helps nobody. */
  const badge = useMemo(() => {
    const value = Math.floor(Number(unread) || 0);
    if (value <= 0) return null;
    return value > 99 ? "99+" : String(value);
  }, [unread]);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={badge ? t("notifications.unread_label", { count: unread }) : t("notifications.title")}
      onPress={onPress ?? (() => router.push("/notifications" as never))}
      style={styles.bell}
    >
      <View style={styles.inner}>
        <Svg width={19} height={19} viewBox="0 0 24 24">
          <Path d={BELL} fill="none" stroke={TEXT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
        {badge ? (
          <View style={[styles.badge, accent ? { backgroundColor: accent } : null]}>
            <Text style={styles.badgeText} numberOfLines={1}>{badge}</Text>
          </View>
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  bell: { borderRadius: 15 },
  inner: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 15, ...card },
  /* La pastille déborde volontairement du cadre : posée dedans, elle
     masquerait la cloche dès deux chiffres. */
  badge: {
    position: "absolute", top: -4, right: -5, minWidth: 20, paddingHorizontal: 5, paddingVertical: 1,
    borderRadius: 50, backgroundColor: "#c34251", alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: colors.background,
  },
  badgeText: { color: colors.paper, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, fontSize: 10 },
});
