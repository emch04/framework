/**
 * A press that answers immediately.
 *
 * Native apps confirm a touch before the network does anything. Without it a
 * tap feels lost, and people tap again — which is how a payment gets sent
 * twice.
 */
import { useRef } from 'react';
import { Animated, Pressable, type PressableProps, type ViewStyle } from 'react-native';

export function AnimatedPressable({ children, style, ...props }: PressableProps & { style?: ViewStyle }) {
  const scale = useRef(new Animated.Value(1)).current;

  const to = (value: number) => Animated.spring(scale, {
    toValue: value,
    useNativeDriver: true,
    speed: 40,
    bounciness: 4
  }).start();

  return (
    <Pressable
      onPressIn={() => to(0.97)}
      onPressOut={() => to(1)}
      {...props}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

/* Both shapes exported: the screens here import it by name, the ported
   components by default. Neither should have to change to match the other. */
export default AnimatedPressable;
