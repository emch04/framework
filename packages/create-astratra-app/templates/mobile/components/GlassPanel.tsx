/**
 * The translucent surface — a real one, on both platforms.
 *
 * The first version blurred on iOS and painted a flat plate everywhere else.
 * That was wrong: Android renders a genuine backdrop blur, it just has to be
 * asked for by name (`experimentalBlurMethod`, handled by `blurPropsFor`).
 * Asked properly, both platforms get the same material.
 *
 * THE BLUR IS A LAYER, NOT THE CONTAINER. It fills the panel behind the
 * content, and the border and radius live on the wrapper. Putting content
 * inside a BlurView makes the content itself blurry on some Android versions.
 *
 * NO `elevation` HERE. Android draws elevation against an opaque background:
 * given a translucent one it paints a solid rectangle behind the whole view —
 * a white block inside the card, which is exactly how it looked. The blur and
 * the border do the separating instead.
 */
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { blurPropsFor, resolveGlassMode } from '@astratra/native';
import { colors } from '../constants/theme';

const mode = resolveGlassMode({
  platform: Platform.OS,
  apiAvailable: true,
  effectAvailable: Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26,
  /* expo-blur covers iOS and Android; only the web build has no real blur. */
  blurAvailable: Platform.OS !== 'web'
});

const blurred = mode !== 'fallback';

export function GlassPanel({ style, children, ...props }: ViewProps) {
  return (
    <View
      style={[
        {
          borderRadius: 20,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 18,
          overflow: 'hidden',
          /* A blurred panel needs only a veil of colour; a flat one has to
             carry the whole surface itself. */
          backgroundColor: blurred ? colors.veil : colors.surfaceOpaque
        },
        Platform.OS === 'ios' ? styles.lift : null,
        style
      ]}
      {...props}
    >
      {blurred && <BlurView {...blurPropsFor(Platform.OS)} style={StyleSheet.absoluteFill} />}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  /* iOS renders this softly; Android ignores shadow* entirely, and its
     `elevation` equivalent is incompatible with a translucent background. */
  lift: {
    shadowColor: '#18234f',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 }
  }
});
