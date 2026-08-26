/**
 * A screen that holds a form, and the keyboard that covers it.
 *
 * This was the same twenty lines pasted onto every screen with a text field —
 * and pasted with DRIFT, which is the part that hurts: three screens, three
 * different `behavior` values, so the keyboard pushed the layout differently
 * depending on where you were.
 *
 * ANDROID TAKES NO `behavior`, AND THAT IS DELIBERATE. Expo sets
 * `softwareKeyboardLayoutMode: 'resize'` by default, so the OS already shrinks
 * the window when the keyboard opens. Adding `behavior="height"` on top makes
 * the app correct for the same thing twice — the layout jumps, and inputs end
 * up under the keyboard anyway. iOS does not resize, so it needs `padding`.
 *
 * SCROLLING IS ON BY DEFAULT. A form that fits today stops fitting on a small
 * phone, in a larger font, or in a language with longer words. `flexGrow: 1`
 * keeps a short form vertically centred while letting a long one scroll.
 *
 * A DRAG DISMISSES THE KEYBOARD, A TAP DOES NOT. `keyboardShouldPersistTaps`
 * is what lets someone tap "Sign in" while the keyboard is still up: without
 * it the first tap only closes the keyboard and the button appears dead.
 */
import type { ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../constants/theme';

export function KeyboardScreen({
  children,
  scroll = true,
  offset = 0,
  style,
  contentStyle,
  background
}: {
  children: ReactNode;
  /** Turn off for a screen that manages its own scrolling — a chat, a long list. */
  scroll?: boolean;
  /** Height of anything fixed above the form (a header), in points. */
  offset?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Rendered behind everything: a gradient, a grid, an image. */
  background?: ReactNode;
}) {
  const body = scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      contentContainerStyle={[{ flexGrow: 1 }, contentStyle]}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
  );

  return (
    <View style={[{ flex: 1, backgroundColor: colors.background }, style]}>
      {background}
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={offset}
        >
          {body}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
