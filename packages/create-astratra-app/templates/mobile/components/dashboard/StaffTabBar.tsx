import { useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import LiquidGlassSurface from "../glass/LiquidGlassSurface";
import { accentAlpha, colors, fontWeights, fonts, inkAlpha } from "../../constants/theme";

export type StaffTab = { key: string; label: string; path?: string };
export type StaffTabBarProps = { tabs: StaffTab[]; activeKey: string; onSelect: (tab: StaffTab) => void };

const ICONS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10.5Z",
  students: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm12 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  messages: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  oracle: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  more: "M4 7h16M4 12h16M4 17h16",
  assignments: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  grades: "M18 20V10M12 20V4M6 20v-6",
  children: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  timetable: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
};

export default function StaffTabBar({ tabs, activeKey, onSelect }: StaffTabBarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Rendue en dehors du SafeAreaView (position absolute par-dessus tout l'écran) : on
  // compense nous-mêmes l'inset bas (barre de gestes Android, home indicator iOS) pour
  // que la barre ne soit jamais collée ou chevauchée par la zone système.
  const bottomOffset = Math.max(18, insets.bottom + 8);

  return (
    <View style={[styles.wrapper, { bottom: bottomOffset }]}>
      <LiquidGlassSurface width={screenWidth - 40} height={60} cornerRadius={22} tintColor={colors.paper} tintOpacity={0.10} borderOpacity={0.86} refractionStrength={3} nativeGlass>
        <View style={styles.row}>
          {tabs.map((tab) => <TabItem key={tab.key} tab={tab} active={tab.key === activeKey} onSelect={onSelect} />)}
        </View>
      </LiquidGlassSurface>
    </View>
  );
}

function TabItem({ tab, active, onSelect }: { tab: StaffTab; active: boolean; onSelect: (tab: StaffTab) => void }) {
  const press = useRef(new Animated.Value(0)).current;
  const animate = (toValue: number) => Animated.spring(press, { toValue, friction: 7, tension: 115, useNativeDriver: true }).start();
  const color = active ? colors.accent : inkAlpha(0.52);

  return (
    <Animated.View style={[styles.tabWrap, { transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.93] }) }] }]}>
      <Pressable accessibilityRole="link" accessibilityLabel={tab.label} onPress={() => onSelect(tab)} onPressIn={() => animate(1)} onPressOut={() => animate(0)} style={styles.tab}>
        <View style={[styles.iconShell, active && styles.iconShellActive]}>
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <Path d={ICONS[tab.key] ?? ICONS.more} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
        <Text style={[styles.label, { color }, active && styles.labelActive]} numberOfLines={1}>{tab.label}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: "absolute", left: 20, right: 20, alignItems: "center" },
  row: { flex: 1, flexDirection: "row", paddingHorizontal: 4 },
  tabWrap: { flex: 1 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  iconShell: { width: 29, height: 27, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  iconShellActive: { backgroundColor: accentAlpha(0.12), borderWidth: 1, borderColor: accentAlpha(0.16) },
  label: { fontFamily: fonts.medium, fontWeight: fontWeights.medium, fontSize: 9.5 },
  labelActive: { fontFamily: fonts.bold, fontWeight: fontWeights.bold },
});
