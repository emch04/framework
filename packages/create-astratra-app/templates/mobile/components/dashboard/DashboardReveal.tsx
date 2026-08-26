import { useEffect, useRef } from "react";
import { Animated, Easing, type ViewStyle } from "react-native";

type DashboardRevealProps = {
  children: React.ReactNode;
  delay?: number;
  direction?: "up" | "left";
  style?: ViewStyle;
};

export default function DashboardReveal({ children, delay = 0, direction = "up", style }: DashboardRevealProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const offset = direction === "left" ? { x: -10, y: 0 } : { x: 0, y: 24 };

  // Une seule fois au montage — pas à chaque focus (voir ToolCard.tsx pour le
  // détail du bug que ce changement corrige : rejouer ce fondu à chaque retour
  // sur le dashboard n'était visible que pendant un retour par geste, lent et
  // interruptible, où l'utilisateur voit la carte/le verre se réinitialiser).
  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 500,
      delay,
      easing: Easing.out(Easing.bezier(0.16, 1, 0.3, 1)),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[style, {
        opacity: progress,
        transform: [
          { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [offset.x, 0] }) },
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset.y, 0] }) },
          { scale: direction === "up" ? progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) : 1 },
        ],
      }]}
    >
      {children}
    </Animated.View>
  );
}
