import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, View, Text, StyleSheet, useWindowDimensions } from "react-native";
import { GlassView } from "expo-glass-effect";
import { LinearGradient } from "expo-linear-gradient";
import { accentAlpha, colors, fontWeights, fonts, inkAlpha } from "../../constants/theme";

export type KpiItem = { value: string; label: string; color: string };
export type KpiBubbleProps = { items: KpiItem[] };

export default function KpiBubble({ items }: KpiBubbleProps) {
  const { width } = useWindowDimensions();
  const gradientShift = useRef(new Animated.Value(0)).current;
  const cellAnimations = useRef<Animated.Value[]>([]);
  const [run, setRun] = useState(0);
  const cardWidth = Math.max(width - 40, 300);

  if (cellAnimations.current.length !== items.length) {
    cellAnimations.current = items.map(() => new Animated.Value(0));
  }

  // Une seule fois au montage — pas à chaque focus (voir ToolCard.tsx). Le
  // GlassView natif recalculant son dégradé/fondu à chaque retour sur le
  // dashboard était le principal responsable du flash de couleurs vives
  // pendant un retour par geste (lent, interruptible).
  useEffect(() => {
    const gradientLoop = Animated.loop(
      Animated.timing(gradientShift, {
        toValue: 1,
        duration: 8000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    gradientLoop.start();
    return () => gradientLoop.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const animation = Animated.stagger(
      90,
      cellAnimations.current.map((value) =>
        Animated.timing(value, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ),
    );
    animation.start();
    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gradientTranslate = gradientShift.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -cardWidth],
  });

  return (
    <GlassView
      glassEffectStyle="regular"
      style={[styles.card, Platform.OS !== "ios" && styles.androidFallback]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.gradientTrack,
          {
            width: cardWidth * 2,
            transform: [{ translateX: gradientTranslate }],
          },
        ]}
      >
        <LinearGradient
          colors={[
            accentAlpha(0.10),
            "rgba(52,168,83,0.08)",
            "rgba(230,126,34,0.08)",
            "rgba(124,58,237,0.10)",
            accentAlpha(0.10),
          ]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.gradientFill}
        />
      </Animated.View>

      <View style={styles.grid}>
        {items.map((item, index) => (
          <Animated.View
            key={item.label}
            style={[
              styles.cell,
              index % 2 === 0 && styles.cellRightDivider,
              index < items.length - 2 && styles.cellBottomDivider,
              {
                opacity: cellAnimations.current[index],
                transform: [
                  {
                    translateY: cellAnimations.current[index].interpolate({
                      inputRange: [0, 1],
                      outputRange: [12, 0],
                    }),
                  },
                  {
                    scale: cellAnimations.current[index].interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.94, 1],
                    }),
                  },
                ],
              },
            ]}
          >
            <KpiValue value={item.value} color={item.color} run={run} />
            <Text style={styles.label}>{item.label.toUpperCase()}</Text>
            <View style={styles.barTrack}>
              <Animated.View style={[styles.colorBar, { backgroundColor: item.color, transform: [{ scaleX: cellAnimations.current[index].interpolate({ inputRange: [0, 1], outputRange: [0.05, 1] }) }] }]} />
            </View>
          </Animated.View>
        ))}
      </View>
    </GlassView>
  );
}

function KpiValue({ value, color, run }: { value: string; color: string; run: number }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState(value);
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  const suffix = value.replace(/[0-9.,\s-]/g, "").trim();

  useEffect(() => {
    if (!Number.isFinite(parsed)) { setDisplay(value); return; }
    progress.setValue(0);
    const listener = progress.addListener(({ value: current }) => {
      const next = Math.round(parsed * current).toLocaleString();
      setDisplay(suffix ? `${next} ${suffix}` : next);
    });
    const animation = Animated.timing(progress, { toValue: 1, duration: 720, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    animation.start();
    return () => { animation.stop(); progress.removeListener(listener); };
  }, [parsed, progress, run, suffix, value]);

  return <Text style={[styles.value, { color }]}>{display}</Text>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.92)",
  },
  androidFallback: { backgroundColor: "rgba(255,255,255,0.76)" },
  gradientTrack: { ...StyleSheet.absoluteFillObject, opacity: 1 },
  gradientFill: { flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "50%", alignItems: "center", paddingVertical: 18, paddingHorizontal: 8 },
  cellRightDivider: { borderRightWidth: 1, borderRightColor: inkAlpha(0.07) },
  cellBottomDivider: { borderBottomWidth: 1, borderBottomColor: inkAlpha(0.07) },
  value: { fontSize: 22, fontFamily: fonts.extrabold, fontWeight: fontWeights.extrabold, letterSpacing: -0.5, textAlign: "center" },
  label: { marginTop: 8, fontSize: 9.5, fontFamily: fonts.bold, fontWeight: fontWeights.bold, color: inkAlpha(0.42), letterSpacing: 0.5, textAlign: "center" },
  barTrack: { width: 28, height: 3, marginTop: 9, overflow: "hidden", borderRadius: 2, backgroundColor: inkAlpha(0.06) },
  colorBar: { width: "100%", height: "100%", borderRadius: 2 },
});
