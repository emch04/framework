import { ReactNode } from "react";
import { StyleSheet, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

/* Two steps of the accent. Change these and every showcase screen follows. */
const GRADIENT = ["#4a7af4", "#1a45d4"] as const;

interface BrandBackgroundProps {
  children: ReactNode;
  style?: ViewStyle;
}

/**
 * A full-bleed brand gradient, for showcase screens — a splash, a public
 * landing. Not for screens holding content: coloured ink on a saturated
 * gradient is unreadable.
 */
export default function BrandBackground({ children, style }: BrandBackgroundProps) {
  return (
    <LinearGradient
      colors={GRADIENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.fill, style]}
    >
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
