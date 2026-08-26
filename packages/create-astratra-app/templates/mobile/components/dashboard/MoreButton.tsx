import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Svg, { Path } from "react-native-svg";
import { accentAlpha, colors, fontWeights, fonts } from "../../constants/theme";
import LiquidGlassSurface from "../glass/LiquidGlassSurface";

type MoreButtonProps = {
  label: string;
  onPress: () => void;
  delay?: number;
};

export default function MoreButton({ label, onPress, delay = 0 }: MoreButtonProps) {
  const { width } = useWindowDimensions();
  const press = useRef(new Animated.Value(0)).current;
  const entrance = useRef(new Animated.Value(0)).current;
  // Une seule fois au montage — pas à chaque focus (voir ToolCard.tsx).
  useEffect(() => {
    const animation = Animated.timing(entrance, { toValue: 1, duration: 500, delay, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const animatePress = (toValue: number) => {
    Animated.spring(press, { toValue, friction: 7, tension: 110, useNativeDriver: true }).start();
  };

  return (
    <Animated.View style={[styles.wrapper, { opacity: entrance, transform: [{ translateY: Animated.add(entrance.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }), press.interpolate({ inputRange: [0, 1], outputRange: [0, 2] })) }, { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.985] }) }] }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onPressIn={() => animatePress(1)} onPressOut={() => animatePress(0)} style={styles.pressable}>
        <LiquidGlassSurface width={width - 40} height={48} cornerRadius={16} tintColor={colors.accent} tintOpacity={0.045} borderOpacity={0.84} refractionStrength={3} nativeGlass>
          <View style={styles.button} pointerEvents="none">
            <View style={styles.icon}>
              <Svg width={16} height={16} viewBox="0 0 24 24">
                <Path d="M12 5v14M5 12h14" fill="none" stroke={colors.accent} strokeWidth={2.4} strokeLinecap="round" />
              </Svg>
            </View>
            <Text style={styles.label}>{label}</Text>
          </View>
        </LiquidGlassSurface>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignSelf: "stretch", height: 48 },
  pressable: { width: "100%", height: "100%" },
  button: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: accentAlpha(0.10),
  },
  label: { color: colors.accent, fontFamily: fonts.bold, fontWeight: fontWeights.bold, fontSize: 12.5 },
});
