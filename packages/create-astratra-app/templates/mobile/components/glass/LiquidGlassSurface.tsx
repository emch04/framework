import { useMemo } from "react";
import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import {
  BackdropFilter,
  Canvas,
  Fill,
  Group,
  LinearGradient,
  Path,
  RadialGradient,
  RoundedRect,
  RuntimeShader,
  Skia,
  vec,
} from "@shopify/react-native-skia";
import type { SkRuntimeEffect } from "@shopify/react-native-skia";
import { colors } from "../../constants/theme";

export type LiquidGlassSurfaceProps = {
  width: number;
  height: number;
  cornerRadius?: number;
  tintColor?: string;
  tintOpacity?: number;
  borderOpacity?: number;
  refractionStrength?: number;
  children?: React.ReactNode;
  icon?: { path: string; size?: number; color?: string };
  style?: ViewStyle;
  nativeGlass?: boolean;
};

const REFRACTION_SKSL = `
uniform shader image;
uniform float2 resolution;
uniform float strength;
uniform float cornerRadius;

half4 main(float2 pos) {
  float2 center = resolution * 0.5;
  float2 offset = pos - center;
  float2 halfSize = resolution * 0.5;

  // Distance to the nearest rounded-rect edge, normalized 0 (center) -> 1 (edge)
  float2 d = abs(offset) / halfSize;
  float edge = max(d.x, d.y);

  // Lens bulge: displacement grows toward the edges, curves back to 0 at the exact
  // center so the middle of the card stays undistorted (like the flat top of a
  // glass dome), matching a plano-convex lens profile rather than a uniform blur.
  float bulge = smoothstep(0.15, 1.0, edge) * (1.0 - edge * 0.25);
  float2 dir = length(offset) > 0.0001 ? normalize(offset) : float2(0.0, 0.0);
  float2 displaced = pos - dir * bulge * strength;

  return image.eval(displaced);
}
`;

let cachedRefractionEffect: SkRuntimeEffect | null | undefined;

function getRefractionEffect() {
  if (Platform.OS === "web" || !Skia?.RuntimeEffect?.Make) return null;
  if (cachedRefractionEffect !== undefined) return cachedRefractionEffect;

  try {
    cachedRefractionEffect = Skia.RuntimeEffect.Make(REFRACTION_SKSL) as SkRuntimeEffect | null;
  } catch {
    cachedRefractionEffect = null;
  }
  return cachedRefractionEffect;
}

function hexToRgba(hex: string, alpha: number) {
  const v = hex.replace("#", "");
  const r = parseInt(v.substring(0, 2), 16);
  const g = parseInt(v.substring(2, 4), 16);
  const b = parseInt(v.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function LiquidGlassSurface({
  width,
  height,
  cornerRadius = 18,
  tintColor = colors.accent,
  tintOpacity = 0.10,
  borderOpacity = 0.55,
  refractionStrength = 7,
  children,
  icon,
  style,
  nativeGlass = false,
}: LiquidGlassSurfaceProps) {
  const skiaAvailable = Platform.OS !== "web" && Boolean(Skia?.RuntimeEffect?.Make);
  const refractionEffect = useMemo(() => getRefractionEffect(), []);
  const rrect = useMemo(
    () => ({ rect: { x: 0, y: 0, width, height }, rx: cornerRadius, ry: cornerRadius }),
    [width, height, cornerRadius]
  );

  const iconSkPath = useMemo(
    () => (skiaAvailable && icon ? Skia.Path.MakeFromSVGString(icon.path) : null),
    [icon, skiaAvailable]
  );

  const uniforms = useMemo(
    () => ({ resolution: [width, height], strength: refractionStrength, cornerRadius }),
    [width, height, refractionStrength, cornerRadius]
  );

  const iconSize = icon?.size ?? 26;
  const nativeGlassAvailable = useMemo(() => {
    if (!nativeGlass || Platform.OS !== "ios") return false;

    try {
      return isGlassEffectAPIAvailable();
    } catch {
      return false;
    }
  }, [nativeGlass]);

  return (
    <View style={[styles.surface, { width, height, borderRadius: cornerRadius }, style]}>
      {/* Teinte instantanée : un View à backgroundColor plein est composé dans la
          même passe que le contenu, contrairement au blur/glass natif ou au canvas
          Skia qui ont besoin d'une frame de plus pour se calculer. Sans ce calque,
          une transition de navigation pilotée par geste (retour interactif) révèle
          brièvement les couleurs brutes du contenu avant que l'effet verre réel ne
          se pose dessus — visible surtout en sortant d'un écran sans bouton retour. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius, backgroundColor: hexToRgba(tintColor, tintOpacity) }]}
      />
      {nativeGlassAvailable ? (
        <GlassView
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius }]}
          glassEffectStyle="regular"
          tintColor={hexToRgba(tintColor, tintOpacity)}
          colorScheme="light"
        />
      ) : (
        <BlurView
          pointerEvents="none"
          intensity={34}
          tint="light"
          style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius }]}
        />
      )}
      {!skiaAvailable ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.webFallback,
            {
              borderRadius: cornerRadius,
              borderColor: hexToRgba("#ffffff", Math.max(borderOpacity, 0.76)),
              backgroundColor: hexToRgba(tintColor, tintOpacity),
            },
          ]}
        />
      ) : null}
      {skiaAvailable && refractionEffect ? <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Group clip={rrect}>
          {/* The color now lives in the reflection, not in an opaque card background. */}
          <Fill color={hexToRgba("#ffffff", 0.08)} />
          <RoundedRect x={0} y={0} width={width} height={height} r={cornerRadius} color={hexToRgba(tintColor, 0.07)}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(width, height)}
              colors={[hexToRgba("#ffffff", 0.34), hexToRgba(tintColor, 0.02)]}
            />
          </RoundedRect>
          <RoundedRect x={width * 0.08} y={-height * 0.28} width={width * 0.94} height={height * 0.76} r={height * 0.38} color={hexToRgba("#ffffff", 0.18)}>
            <RadialGradient
              c={vec(width * 0.48, height * 0.04)}
              r={Math.max(width, height) * 0.62}
              colors={[hexToRgba("#ffffff", 0.42), hexToRgba("#ffffff", 0.00)]}
            />
          </RoundedRect>

          {!nativeGlassAvailable && (
            <BackdropFilter filter={<RuntimeShader source={refractionEffect} uniforms={uniforms} />}>
              <RoundedRect
                x={0}
                y={0}
                width={width}
                height={height}
                r={cornerRadius}
                color={hexToRgba(tintColor, tintOpacity)}
              />
            </BackdropFilter>
          )}

          <RoundedRect
            x={0}
            y={0}
            width={width}
            height={height}
            r={cornerRadius}
            color={hexToRgba(tintColor, nativeGlassAvailable ? tintOpacity * 0.48 : tintOpacity)}
          />
          <RoundedRect
            x={0.75}
            y={0.75}
            width={width - 1.5}
            height={height - 1.5}
            r={cornerRadius}
            style="stroke"
            strokeWidth={1.25}
            color={hexToRgba("#ffffff", Math.max(borderOpacity, 0.76))}
          />
          <RoundedRect
            x={1.6}
            y={1.6}
            width={width - 3.2}
            height={height - 3.2}
            r={cornerRadius - 1}
            style="stroke"
            strokeWidth={0.65}
            color={hexToRgba(tintColor, 0.26)}
          />

          {iconSkPath && icon && (
            <Group
              transform={[
                { translateX: 16 },
                { translateY: 16 },
                { scale: iconSize / 24 },
              ]}
            >
              <Path
                path={iconSkPath}
                color={icon.color ?? "#ffffff"}
                style="stroke"
                strokeWidth={2.5}
                strokeCap="round"
                strokeJoin="round"
              />
            </Group>
          )}
        </Group>
      </Canvas> : null}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    overflow: "hidden",
    shadowColor: "#18234f",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 9 },
    elevation: 5,
  },
  webFallback: {
    borderWidth: 1.25,
  },
});
