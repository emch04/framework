import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import LiquidGlassSurface from "../glass/LiquidGlassSurface";
import Svg, { Path } from "react-native-svg";

import { TEXT, colors, fontWeights, fonts } from "../../constants/theme";

/**
 * One tile on the dashboard.
 *
 * `icon` is an SVG path string, not a component: the tiles are declared as
 * data — usually one list per role — and a list of data must not have to
 * import React to say what it looks like.
 */
export type ToolCardItem = {
  label: string;
  value: string;
  color: string;
  path?: string;
  icon: string;
};

export type ToolCardProps = {
  card: ToolCardItem;
  disabled?: boolean;
  onPress?: () => void;
  index?: number;
  /**
   * Total horizontal padding of the grid's container, both sides added.
   *
   * The tile computes its own width, so it has to know how much room the
   * parent already took. Hard-coded, a container with different padding makes
   * every tile a few pixels too wide — and two of them stop fitting on a row,
   * which reads as a broken layout rather than as a maths error.
   */
  gridPadding?: number;
};

const CARD_HEIGHT = 130;
const DEFAULT_GRID_PADDING = 40;
const GRID_GAP = 12;

// iOS supportsTablet (app.json) : sur iPad/écran large, verrouiller à 2 colonnes fixes
// produisait des cartes disproportionnées (très larges, hauteur inchangée). On ajoute
// des colonnes par palier de largeur pour garder un ratio raisonnable.
function getColumnCount(width: number) {
  if (width >= 900) return 4;
  if (width >= 620) return 3;
  return 2;
}

export default function ToolCard({
  card,
  disabled,
  onPress,
  index = 0,
  gridPadding = DEFAULT_GRID_PADDING
}: ToolCardProps) {
  const { width } = useWindowDimensions();
  const columns = getColumnCount(width);
  const cardWidth = Math.floor((width - gridPadding - GRID_GAP * (columns - 1)) / columns);
  const isTextValue = Number.isNaN(Number.parseInt(card.value, 10));
  const entrance = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;

  // Une seule fois au montage — pas à chaque focus. Rejouer ce fondu (et
  // recalculer le verre de chaque carte) à chaque retour sur le dashboard
  // était invisible avec le bouton retour (transition rapide, non
  // interruptible) mais bien visible pendant un retour par geste, lent et
  // interruptible : la carte semblait se réinitialiser sous les yeux.
  useEffect(() => {
    const animation = Animated.timing(entrance, {
      toValue: 1,
      duration: 500,
      delay: Math.min(index, 8) * 55 + 60,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatePress = (toValue: number) => {
    Animated.spring(press, { toValue, friction: 7, tension: 110, useNativeDriver: true }).start();
  };

  return (
    <Animated.View style={[styles.wrapper, { width: cardWidth, opacity: entrance, transform: [{ translateY: Animated.add(entrance.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }), press.interpolate({ inputRange: [0, 1], outputRange: [0, 2] })) }, { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) }] }, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={card.label}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => animatePress(1)}
        onPressOut={() => animatePress(0)}
        style={styles.pressable}
      >
        <LiquidGlassSurface
          width={cardWidth}
          height={CARD_HEIGHT}
          cornerRadius={14}
          tintColor={card.color}
          tintOpacity={0.06}
          borderOpacity={0.86}
          refractionStrength={3}
          nativeGlass
        >
          <View style={styles.content} pointerEvents="none">
            <View style={[styles.iconWrap, { backgroundColor: card.color }]}>
              <Svg width={16} height={16} viewBox="0 0 24 24">
                <Path d={card.icon} fill="none" stroke={colors.paper} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </View>
            <View style={styles.copy}>
              <Text style={[styles.label, { color: card.color }]} numberOfLines={2}>{card.label}</Text>
              <Text style={[styles.value, isTextValue && styles.textValue, { color: card.color }]} numberOfLines={isTextValue ? 2 : 1}>{card.value}</Text>
            </View>
          </View>
        </LiquidGlassSurface>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: { height: CARD_HEIGHT },
  pressable: { width: "100%", height: "100%" },
  disabled: { opacity: 0.38 },
  content: { flex: 1, paddingVertical: 13, paddingHorizontal: 11, justifyContent: "space-between" },
  iconWrap: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", shadowColor: TEXT, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  copy: { gap: 4 },
  label: { fontSize: 11.5, lineHeight: 14, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.9 },
  value: { fontSize: 21, lineHeight: 23, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, letterSpacing: -1 },
  textValue: { fontSize: 15, lineHeight: 19, fontFamily: fonts.bold, fontWeight: fontWeights.bold, letterSpacing: 0 },
});
