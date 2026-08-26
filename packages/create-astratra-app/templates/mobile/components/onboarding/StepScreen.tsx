import { ReactNode, useEffect, useRef } from "react";
import {
  View,
  Text,
  Animated,
  Easing,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  Keyboard,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { MUTED, accentAlpha, colors, fontWeights, fonts } from "../../constants/theme";
import Pressable from "../AnimatedPressable";

/* A default, not a law: an onboarding is as long as the product needs.
   Hard-coded, it silently mislabels "step 3 of 5" in a four-step flow. */
const DEFAULT_TOTAL_STEPS = 5;

interface StepScreenProps {
  step: number; // 1-indexed
  /** How many steps the flow has. Defaults to five. */
  totalSteps?: number;
  eyebrow: string;
  title: string;
  children: ReactNode;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
}

/**
 * The shell every step of a sign-up flow sits in: progress bar, title, content,
 * primary button and an optional skip.
 *
 * It carries the keyboard handling too — a step screen almost always holds a
 * form, and the layout has to survive the keyboard opening over it.
 */
export default function StepScreen({
  step,
  totalSteps = DEFAULT_TOTAL_STEPS,
  eyebrow,
  title,
  children,
  onNext,
  nextLabel,
  nextDisabled = false,
  onSkip,
  skipLabel,
}: StepScreenProps) {
  const { t } = useTranslation();
  const progressValues = useRef(
    Array.from(
      { length: totalSteps },
      (_, i) => new Animated.Value(i < step - 1 ? 1 : i === step - 1 ? 0.5 : 0),
    ),
  ).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentTranslate = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel(
      progressValues.map((value, i) =>
        Animated.timing(value, {
          toValue: i < step - 1 ? 1 : i === step - 1 ? 0.5 : 0,
          duration: 280,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ),
    ).start();
  }, [progressValues, step]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentTranslate, {
        toValue: 0,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [contentOpacity, contentTranslate]);

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1 }}
          onScrollBeginDrag={Keyboard.dismiss}
        >
          <View style={styles.topbar}>
            {router.canGoBack() && (
              <Pressable onPress={() => router.back()}>
                <Text style={styles.back}>‹ {t("common.back")}</Text>
              </Pressable>
            )}
            <View style={styles.progress}>
              {Array.from({ length: totalSteps }).map((_, i) => (
                <Animated.View
                  key={i}
                  style={[
                    styles.seg,
                    {
                      backgroundColor: progressValues[i].interpolate({
                        inputRange: [0, 0.5, 1],
                        outputRange: [accentAlpha(0.14), colors.accent, colors.accent],
                      }),
                      opacity: progressValues[i].interpolate({
                        inputRange: [0, 0.5, 1],
                        outputRange: [1, 0.55, 1],
                      }),
                    },
                  ]}
                />
              ))}
            </View>
          </View>

          <Animated.View
            style={[
              styles.content,
              { opacity: contentOpacity, transform: [{ translateY: contentTranslate }] },
            ]}
          >
            <Text style={styles.eyebrow}>
              {eyebrow} · {t("common.step_progress", { step, total: totalSteps })}
            </Text>
            <Text style={styles.title}>{title}</Text>

            <View style={styles.body}>{children}</View>

            <Pressable
              style={[styles.primary, nextDisabled && styles.primaryDisabled]}
              onPress={onNext}
              disabled={nextDisabled}
            >
              <Text style={styles.primaryText}>{nextLabel ?? t("common.continue")}</Text>
            </Pressable>

            {onSkip && (
              <Pressable style={styles.ghost} onPress={onSkip}>
                <Text style={styles.ghostText}>{skipLabel ?? t("common.skip")}</Text>
              </Pressable>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topbar: { paddingHorizontal: 20, paddingTop: 8 },
  back: { fontSize: 13, fontFamily: fonts.medium, fontWeight: fontWeights.medium, color: MUTED, marginBottom: 10 },
  progress: { flexDirection: "row", gap: 5, marginBottom: 6 },
  seg: { flex: 1, height: 4, borderRadius: 3, backgroundColor: accentAlpha(0.14) },
  segDone: { backgroundColor: colors.accent },
  segNow: { backgroundColor: colors.accent, opacity: 0.55 },
  content: { flex: 1, padding: 22, paddingTop: 24 },
  eyebrow: { fontSize: 11, fontFamily: fonts.bold, fontWeight: fontWeights.bold, color: "#12206e", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  title: { fontSize: 20, fontFamily: fonts.bold, fontWeight: fontWeights.bold, color: "#2f3350", marginBottom: 22, lineHeight: 26 },
  body: { flex: 1 },
  primary: { backgroundColor: colors.accent, borderRadius: 26, paddingVertical: 15, alignItems: "center" },
  primaryDisabled: { opacity: 0.4 },
  primaryText: { color: "#fff", fontFamily: fonts.bold, fontWeight: fontWeights.bold, fontSize: 14 },
  ghost: { paddingVertical: 12, alignItems: "center" },
  ghostText: { color: MUTED, fontFamily: fonts.semibold, fontWeight: fontWeights.semibold, fontSize: 13 },
});
