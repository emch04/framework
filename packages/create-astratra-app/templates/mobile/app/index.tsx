/**
 * The splash: it decides where to go, so the guard does not have to.
 *
 * While the session restores, nothing is decided. Redirecting on the transient
 * state is what makes the sign-in screen flash at every cold start.
 */
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { colors } from '../constants/theme';

export default function Splash() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/dashboard' : '/home');
  }, [user, loading, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
